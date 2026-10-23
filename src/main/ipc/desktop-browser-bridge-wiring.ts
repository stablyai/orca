/**
 * Production wiring for the desktop browser bridge: which managed SSH hosts may attach, how to
 * reach their orcad over the paired encrypted connection, and how a forwarded command runs here.
 */
import { randomUUID } from 'node:crypto'
import { webContents, type BrowserWindow } from 'electron'
import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
  isDesktopBrowserBridgeMethod
} from '../../shared/desktop-browser-bridge-protocol'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairedRuntimeConnection
} from '../../shared/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { isRemoteCliControlAllowed } from '../../shared/ssh-remote-cli-control'
import { browserManager } from '../browser/browser-manager'
import {
  DesktopBrowserBridgeManager,
  type DesktopBrowserBridgeCandidate
} from '../browser/desktop-browser-bridge/desktop-browser-bridge-manager'
import {
  executeDesktopBrowserBridgeRequest,
  isHostReachableDocument
} from '../browser/desktop-browser-bridge/desktop-browser-bridge-executor'
import { rendererResolveRemoteCliWorkspace } from '../browser/desktop-browser-bridge/desktop-browser-bridge-renderer-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { ensureOrcadManagedTunnel } from '../managed-server/lifecycle/orcad-managed-tunnel'
import { getSshTargetRegistryStore } from '../ssh/targets/ssh-target-registry'
import type { SshConnectionManager } from '../ssh/connection/ssh-connection-manager'
import { getRuntimeEnvironmentStatus } from './runtime-environments/runtime-environment-status-probe'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environments/runtime-environment-connectivity-handlers'
import { setDesktopBrowserBridgeControl } from './desktop-browser-bridge-reconcile'
import { markRemoteCliDrivenWorkspace } from '../browser/desktop-browser-bridge/remote-cli-driven-workspaces'
import { persistedStore } from './ssh/ssh-ipc-context'
import { localSshBrowserTargetIdForSession } from '../browser/local-ssh-browser-partitions'

const ATTACH_TIMEOUT_MS = 15_000
const BRIDGE_CLIENT_ID = randomUUID()

let manager: DesktopBrowserBridgeManager | null = null
let stopWatchingRoutingSettings: (() => void) | null = null

function log(message: string): void {
  console.info(`[desktop-browser-bridge] ${message}`)
}

export function listDesktopBrowserBridgeCandidates(
  userDataPath: string,
  connections: Pick<SshConnectionManager, 'getState'> | null
): DesktopBrowserBridgeCandidate[] {
  const candidates: DesktopBrowserBridgeCandidate[] = []
  for (const target of getSshTargetRegistryStore()?.listTargets() ?? []) {
    if (!isRemoteCliControlAllowed(target)) {
      continue
    }
    if (connections?.getState(target.id)?.status !== 'connected') {
      continue
    }
    // Why first: with the switch on by default, every plain host reaches here; only managed ones qualify.
    const environmentId = getManagedOrcadFenceEnvironmentId(target)
    if (!environmentId || isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      continue
    }
    // Why: an unrouted host's pages egress from this desktop, so it must not stay attached at all.
    if (!isSshTargetBrowsingRouted(target.id)) {
      continue
    }
    try {
      const environment = resolveEnvironment(userDataPath, environmentId)
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
  let dispatcher: RpcDispatcher | null = null
  const getDispatcher = (): RpcDispatcher => {
    dispatcher ??= new RpcDispatcher({
      runtime,
      // Why a registry of only these methods: even a bug upstream cannot reach anything else.
      methods: ALL_RPC_METHODS.filter((method) => isDesktopBrowserBridgeMethod(method.name)),
      callerScope: { kind: 'runtime-paired', grants: [] }
    })
    return dispatcher
  }
  manager = new DesktopBrowserBridgeManager({
    listCandidates: () =>
      listDesktopBrowserBridgeCandidates(userDataPath, options.getConnectionManager()),
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
        resolveEnvironment(userDataPath, environmentId)
      )
      return subscribeRemoteRuntimeRequest(
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
            DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY
          ]
        }
      )
    },
    execute: (candidate, request, signal, hostRevoked) =>
      executeDesktopBrowserBridgeRequest(
        request,
        {
          environmentId: candidate.environmentId,
          hostLabel: candidate.hostLabel,
          resolveWorkspace: (scope) =>
            rendererResolveRemoteCliWorkspace(getMainWindow, {
              environmentId: candidate.environmentId,
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
              ...(scope.page ? { pageId: scope.page } : {})
            }),
          markWorkspaceDriven: markRemoteCliDrivenWorkspace,
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
            getDispatcher().dispatch({ id: randomUUID(), authToken: '', method, params }),
          audit: (entry) => log(`audit ${JSON.stringify(entry)}`)
        },
        signal,
        hostRevoked
      ),
    log
  })
  // Why: turning routing off for a host must detach it (and cancel its waiting commands) at once.
  stopWatchingRoutingSettings?.()
  // Why optional: test doubles of the store omit the listener API.
  stopWatchingRoutingSettings =
    persistedStore?.onSettingsChanged?.((updates) => {
      if (
        'browserSshWorkspaceRoutingEnabled' in updates ||
        'browserSshWorkspaceRoutingDisabledTargetIds' in updates
      ) {
        manager?.reconcile()
      }
    }) ?? null
  setDesktopBrowserBridgeControl({
    reconcile: () => manager?.reconcile(),
    resetEnvironment: (environmentId) => manager?.resetEnvironment(environmentId)
  })
  manager.reconcile()
}

// Mirrors the renderer's route eligibility: routing on globally and not opted out for this host.
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
  setDesktopBrowserBridgeControl(null)
  manager?.dispose()
  manager = null
}
