/** Route eligible SSH hosts through their paired orcad connection to this desktop's browser bridge. */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, webContents, type BrowserWindow } from 'electron'
import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_EXPECT_URL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_TAB_CREATE_FOCUS_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_TAB_ANNOTATIONS_CAPABILITY,
  isDesktopBrowserBridgeMethod,
  isHostReachableDocument
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY } from '../../../shared/browser/client-hosting/desktop-browser-bridge-file-transfer-protocol'
import { DesktopBrowserBridgeHostFiles } from '../../browser/desktop-browser-bridge/desktop-browser-bridge-host-files'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairedRuntimeConnection
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/remote-runtime/ssh/managed-orcad-ssh-owner'
import { isRemoteCliControlAllowed } from '../../../shared/remote-runtime/ssh/ssh-remote-cli-control'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import {
  DesktopBrowserBridgeManager,
  type DesktopBrowserBridgeCandidate
} from '../../browser/desktop-browser-bridge/desktop-browser-bridge-manager'
import { executeDesktopBrowserBridgeRequest } from '../../browser/desktop-browser-bridge/desktop-browser-bridge-executor'
import { rendererResolveRemoteCliWorkspace } from '../../browser/desktop-browser-bridge/desktop-browser-bridge-renderer-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { getRuntimeEnvironmentStatus } from '../runtime-environments/status/runtime-environment-status-probe'
import { isRuntimeEnvironmentManuallyDisconnected } from '../runtime-environments/connectivity/runtime-environment-manual-disconnect'
import {
  isDesktopBrowserBridgeHostStopped,
  setDesktopBrowserBridgeControl
} from './desktop-browser-bridge-reconcile'
import {
  noticeDesktopBrowserBridgeHostControl,
  registerDesktopBrowserBridgeHostControlIpc,
  type DesktopBrowserBridgeHostControlDeps
} from './desktop-browser-bridge-host-control'
import { markRemoteCliDrivenWorkspace } from '../../browser/desktop-browser-bridge/remote-cli-driven-workspaces'
import { persistedStore } from '../ssh/ssh-ipc-context'
import { localSshBrowserTargetIdForSession } from '../../browser/routing/local-host-partitions/local-ssh-browser-partitions'
import { isTeamBrowserUseBlocked } from '../../browser/browser-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { onTeamFeatureBlockChanged } from '../../orca-profiles/cloud-auth/active-team-capabilities'

const ATTACH_TIMEOUT_MS = 15_000
const BRIDGE_CLIENT_ID = randomUUID()

let manager: DesktopBrowserBridgeManager | null = null
// One per host: creating one sweeps its staging, which live transfers still use.
const hostFilesByEnvironmentId = new Map<string, DesktopBrowserBridgeHostFiles>()
const hostLabelByEnvironmentId = new Map<string, string>()

function hostFilesFor(candidate: DesktopBrowserBridgeCandidate): DesktopBrowserBridgeHostFiles {
  const { environmentId } = candidate
  hostLabelByEnvironmentId.set(environmentId, candidate.hostLabel)
  let files = hostFilesByEnvironmentId.get(candidate.environmentId)
  if (!files) {
    const scope = createHash('sha256').update(candidate.environmentId).digest('hex').slice(0, 16)
    files = new DesktopBrowserBridgeHostFiles({
      stagingRoot: path.join(app.getPath('temp'), 'orca-desktop-browser-bridge-files', scope),
      hostLabel: () => hostLabelByEnvironmentId.get(environmentId) ?? candidate.hostLabel
    })
    hostFilesByEnvironmentId.set(candidate.environmentId, files)
  }
  return files
}
let stopWatchingRoutingSettings: (() => void) | null = null
let stopWatchingTeamPolicy: (() => void) | null = null

function log(message: string): void {
  console.info(`[desktop-browser-bridge] ${message}`)
}

export async function listDesktopBrowserBridgeCandidates(
  userDataPath: string,
  connections: Pick<SshConnectionManager, 'getState'> | null
): Promise<DesktopBrowserBridgeCandidate[]> {
  if (isTeamBrowserUseBlocked()) {
    return []
  }
  const candidates: DesktopBrowserBridgeCandidate[] = []
  // Why: a managed host's eligibility follows its orcad claim, not whether it is listed in SSH
  // settings; environment recipes connect runtime-owned targets that are claimed the same way.
  for (const target of getSshTargetRegistryStore()?.getOrcadRuntimeClaims().listTargets() ?? []) {
    if (!isRemoteCliControlAllowed(target) || isDesktopBrowserBridgeHostStopped(target.id)) {
      continue
    }
    if (connections?.getState(target.id)?.status !== 'connected') {
      continue
    }
    // Only managed hosts qualify even when the global switch defaults on.
    const environmentId = getManagedOrcadFenceEnvironmentId(target)
    if (!environmentId || isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      continue
    }
    // Detached routing must not retain desktop egress authority.
    if (!isSshTargetBrowsingRouted(target.id)) {
      continue
    }
    try {
      const environment = await resolveEnvironment(userDataPath, environmentId)
      if (getOrcadSshDeployment(environment)?.sshTargetId !== target.id) {
        continue
      }
    } catch {
      continue
    }
    candidates.push({ environmentId, targetId: target.id, hostLabel: target.label })
  }
  return candidates
}

export function installDesktopBrowserBridge(options: {
  userDataPath: string
  runtime: OrcaRuntimeService
  getMainWindow: () => BrowserWindow | null
  getConnectionManager: () => Pick<SshConnectionManager, 'getState'> | null
}): void {
  if (manager) {
    manager.reconcile()
    return
  }
  const { userDataPath, runtime, getMainWindow } = options
  const hostControlDeps = (): DesktopBrowserBridgeHostControlDeps => ({
    settings: persistedStore,
    targets: getSshTargetRegistryStore(),
    endHostActivity: (targetId) => browserManager.endAgentCommandsFromHost(targetId)
  })
  registerDesktopBrowserBridgeHostControlIpc(hostControlDeps)
  let dispatcher: RpcDispatcher | null = null
  const getDispatcher = (): RpcDispatcher => {
    dispatcher ??= new RpcDispatcher({
      runtime,
      // Restrict the registry even if an upstream caller misroutes a method.
      methods: ALL_RPC_METHODS.filter((method) => isDesktopBrowserBridgeMethod(method.name)),
      callerScope: { kind: 'runtime-paired', grants: [] }
    })
    return dispatcher
  }
  manager = new DesktopBrowserBridgeManager({
    listCandidates: async () =>
      await listDesktopBrowserBridgeCandidates(userDataPath, options.getConnectionManager()),
    supportsBridge: async (environmentId) => {
      const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, undefined, {
        observeOnly: true
      })
      if (!status.ok) {
        throw new Error(status.error.code)
      }
      return (status.result.capabilities ?? []).includes(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)
    },
    subscribe: (environmentId) => async (callbacks) => {
      await ensureOrcadManagedTunnel(userDataPath, environmentId)
      const connection = getPreferredPairedRuntimeConnection(
        await resolveEnvironment(userDataPath, environmentId)
      )
      return subscribeRemoteRuntimeTransport(
        connection,
        'desktopBrowserBridge.attach',
        { bridgeClientId: BRIDGE_CLIENT_ID },
        ATTACH_TIMEOUT_MS,
        {
          onResponse: callbacks.onResponse,
          onError: (error) => callbacks.onError(error),
          onClose: callbacks.onClose
        },
        {
          clientCapabilities: [
            ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
            DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_EXPECT_URL_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_TAB_ANNOTATIONS_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_TAB_CREATE_FOCUS_CAPABILITY,
            DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY
          ]
        }
      )
    },
    execute: (candidate, request, signal, hostRevoked, host) =>
      executeDesktopBrowserBridgeRequest(
        request,
        {
          environmentId: candidate.environmentId,
          targetId: candidate.targetId,
          hostLabel: candidate.hostLabel,
          resolveWorkspace: (scope) =>
            rendererResolveRemoteCliWorkspace(getMainWindow, {
              environmentId: candidate.environmentId,
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
              // The renderer knows tabs, not the popups they open.
              ...(scope.page ? { pageId: browserManager.getOwningTabIdForPage(scope.page) } : {})
            }),
          markWorkspaceDriven: (workspaceId) => {
            markRemoteCliDrivenWorkspace(workspaceId)
            noticeDesktopBrowserBridgeHostControl(candidate, getMainWindow, hostControlDeps())
          },
          isHostBrowsingRouted: () => isSshTargetBrowsingRouted(candidate.targetId),
          isGuestRoutedThroughHost: (webContentsId) => {
            const guest = webContents.fromId(webContentsId)
            return Boolean(
              guest &&
              !guest.isDestroyed() &&
              localSshBrowserTargetIdForSession(guest.session) === candidate.targetId &&
              isHostReachableDocument(guest.getURL())
            )
          },
          worktreeIdForPage: (browserPageId) =>
            browserManager.getWorktreeIdForTab(browserPageId) ?? null,
          dispatch: (method, params) =>
            // Why: the SSH host's orca CLI is an agent caller; the cursor and tab badge key off it.
            getDispatcher().dispatch(
              { id: randomUUID(), authToken: '', method, params },
              { caller: { kind: 'local-cli' } }
            ),
          hostFiles: hostFilesFor(candidate),
          audit: (entry) => log(`audit ${JSON.stringify(entry)}`)
        },
        signal,
        hostRevoked,
        host
      ),
    log
  })
  // Routing changes must immediately detach hosts and cancel pending commands.
  stopWatchingRoutingSettings?.()
  stopWatchingRoutingSettings =
    persistedStore?.onSettingsChanged?.((updates) => {
      if (
        'browserSshWorkspaceRoutingEnabled' in updates ||
        'browserSshWorkspaceRoutingDisabledTargetIds' in updates
      ) {
        manager?.reconcile()
      }
    }) ?? null
  stopWatchingTeamPolicy?.()
  stopWatchingTeamPolicy = onTeamFeatureBlockChanged(ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse, () =>
    manager?.reconcile()
  )
  setDesktopBrowserBridgeControl({
    reconcile: () => manager?.reconcile(),
    resetEnvironment: (environmentId) => manager?.resetEnvironment(environmentId)
  })
  manager.reconcile()
}

function isSshTargetBrowsingRouted(targetId: string): boolean {
  const settings = persistedStore?.getSettings()
  return (
    settings?.browserSshWorkspaceRoutingEnabled !== false &&
    !settings?.browserSshWorkspaceRoutingDisabledTargetIds?.includes(targetId)
  )
}

export function disposeDesktopBrowserBridge(): void {
  stopWatchingRoutingSettings?.()
  stopWatchingRoutingSettings = null
  stopWatchingTeamPolicy?.()
  stopWatchingTeamPolicy = null
  setDesktopBrowserBridgeControl(null)
  manager?.dispose()
  manager = null
}
