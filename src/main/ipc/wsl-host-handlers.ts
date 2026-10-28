import { BrowserWindow, ipcMain } from 'electron'
import { noteWslHostUserAction } from '../wsl/wsl-host-user-actions'
import {
  WSL_HOST_STATUS_CHANNEL,
  type WslHostAddResult,
  type WslHostCapability,
  type WslHostStatus
} from '../../shared/wsl-host-types'
import type { Store } from '../persistence'
import { createWslHostConnector } from '../wsl/wsl-host-connector'
import { releaseUnwantedWslHolders, wslHolderKeepPolicy } from '../wsl/wsl-orphan-holder-release'
import {
  createFakeWslHostConnector,
  readFakeWslHostsConfig
} from '../wsl/wsl-host-e2e-fake-connector'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { WslHostService } from '../wsl/wsl-host-service'
import { WslHostVisibleWorkByWindow } from './wsl-host-visible-work-windows'
import type { WslHostAutomationWake } from '../wsl/wsl-host-automation-wake'
import { createWslHostAutomationWake } from './wsl-host-automation-wake-wiring'
import {
  WSL_HOSTS_NEW_WORK_PAUSED_MESSAGE,
  wslHostsGateOpen,
  wslHostsServing
} from '../wsl/wsl-host-gate'
import { getWslHostService, setWslHostService } from '../wsl/wsl-host-service-instance'
import { retireRemovedRuntimeEnvironment } from './runtime-environments/runtime-environment-removal-cleanup'
import { getRuntimeEnvironmentStatus } from './runtime-environments/runtime-environment-status-probe'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { isRemoteRuntimeConnectionReady } from './runtime-environments/runtime-environment-request-connections'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import type { WslHostRuntimeAccess } from '../wsl/wsl-host-server-stop'
import {
  changesWslHostAccounts,
  pushWslOrcadHostAccountEnv
} from '../wsl/wsl-orcad-host-account-push'
import { wslOrcadHostSupports } from '../wsl/wsl-orcad-host-environments'
import { wslHostConnectOptions } from '../wsl/wsl-host-connect-request'

export const WSL_HOST_HANDLER_CHANNELS = [
  'wslHosts:listDistros',
  'wslHosts:add',
  'wslHosts:remove',
  'wslHosts:connect',
  'wslHosts:getStatuses',
  'wslHosts:setVisibleWork',
  'wslHosts:focusHost',
  'wslHosts:getCapability'
] as const

function publish(status: WslHostStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send(WSL_HOST_STATUS_CHANNEL, status)
      } catch {
        /* A renderer can close during publication. */
      }
    }
  }
}

function wslHostRuntimeAccess(getUserDataPath: () => string): WslHostRuntimeAccess {
  return {
    isReady: (environmentId) =>
      isRemoteRuntimeConnectionReady(
        environmentId,
        getPreferredPairedRuntimeConnection(resolveEnvironment(getUserDataPath(), environmentId))
      ),
    call: async (environmentId, method, params) => {
      const response = await callRuntimeEnvironment(
        getUserDataPath(),
        environmentId,
        method,
        params
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    },
    census: (environmentId) =>
      requestOrcadTerminalCensus(
        getPreferredPairedRuntimeConnection(resolveEnvironment(getUserDataPath(), environmentId)),
        0
      )
  }
}

function pushHostAccounts(
  getUserDataPath: () => string,
  environmentId: string,
  distro: string
): void {
  const call = (method: string, params: unknown) =>
    callRuntimeEnvironment(getUserDataPath(), environmentId, method, params)
  void pushWslOrcadHostAccountEnv({
    environmentId,
    distro,
    call,
    hostSupports: (capability) =>
      wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
  })
}

type WslHostHandlerArgs = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

function createService(args: WslHostHandlerArgs): WslHostService | null {
  // A closed gate must prevent service adoption, WSL spawns and reconnects; serve-only keeps saved hosts.
  if (!wslHostsServing()) {
    return null
  }
  const fake = readFakeWslHostsConfig()
  if (process.platform !== 'win32' && !fake) {
    return null
  }
  let automationWake: WslHostAutomationWake | null = null
  const created = new WslHostService({
    userDataPath: args.getUserDataPath,
    isEnabled: () => args.store.getSettings().experimentalWslHosts === true,
    hasServerFiles: fake ? () => fake.serverFiles !== 'missing' : hasOrcadTemplate,
    publish,
    pairingChanged: (environmentId) => void args.invalidateTransport(environmentId),
    ready: (environmentId) => {
      void getRuntimeEnvironmentStatus(args.getUserDataPath(), environmentId, undefined, {
        reconnect: true
      }).catch(() => {})
      const distro = created.recordForEnvironment(environmentId)?.distro
      if (distro) {
        pushHostAccounts(args.getUserDataPath, environmentId, distro)
      }
      void automationWake?.learn(environmentId)
    },
    removed: (environmentId) => {
      automationWake?.forget(environmentId)
      return retireRemovedRuntimeEnvironment(
        environmentId,
        args.invalidateTransport,
        args.store,
        args.getUserDataPath()
      )
    }
  })
  const onChange = created.handleConnectionChange.bind(created)
  const isKnownDistro = (distro: string): boolean => created.isKnownDistro(distro)
  const runtime = wslHostRuntimeAccess(args.getUserDataPath)
  created.attach(
    fake
      ? createFakeWslHostConnector(fake, onChange, { isKnownDistro, runtime })
      : createWslHostConnector({
          userDataPath: args.getUserDataPath(),
          onChange,
          hasUserVisibleWork: (distro) => created.hasUserVisibleWork(distro),
          isKnownDistro,
          runtime
        })
  )
  automationWake = createWslHostAutomationWake(args.getUserDataPath, created)
  return created
}

function startService(args: WslHostHandlerArgs): WslHostService | null {
  const created = createService(args)
  if (!created) {
    return null
  }
  setWslHostService(created)
  args.store.onSettingsChanged((updates, settings) => {
    if (changesWslHostAccounts(updates)) {
      for (const status of created.getStatuses()) {
        if (status.state === 'ready') {
          pushHostAccounts(args.getUserDataPath, status.environmentId, status.distro)
        }
      }
    }
    if ('experimentalWslHosts' in updates) {
      void created.enabledChanged(settings.experimentalWslHosts === true).catch((error) => {
        console.warn('[wsl-hosts] Could not apply the WSL hosts setting:', error)
      })
    }
  })
  void created.start().catch((error: unknown) => {
    console.warn('[wsl-hosts] Could not adopt WSL distro holders:', error)
  })
  return created
}

let gatedOffHoldersReleased = false

/**
 * With the gate closed, a launch still releases orphans (no host record, or a pending Remove)
 * but keeps every host's holder: a tester reopening Orca without the gate must not end a live
 * host's sessions. With no holder recorded it touches nothing beyond one folder check.
 */
function releaseHoldersWhileGatedOff(userDataPath: string): void {
  if (process.platform !== 'win32' || gatedOffHoldersReleased) {
    return
  }
  gatedOffHoldersReleased = true
  void releaseUnwantedWslHolders({
    userDataPath,
    isWanted: wslHolderKeepPolicy({ userDataPath, keepHostHolders: true })
  }).catch((error: unknown) => {
    console.warn('[wsl-hosts] Could not release orphaned WSL distro holders:', error)
  })
}

export function registerWslHostHandlers(args: WslHostHandlerArgs): void {
  for (const channel of WSL_HOST_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  // Install no API without a service, matching the preload gate.
  const wsl = getWslHostService() ?? startService(args)
  if (!wsl) {
    releaseHoldersWhileGatedOff(args.getUserDataPath())
    return
  }
  ipcMain.handle('wslHosts:listDistros', () => wsl.listDistros())
  ipcMain.handle(
    'wslHosts:add',
    async (
      _event,
      request: { distro: string; startIfStopped?: boolean }
    ): Promise<WslHostAddResult> => {
      // Serve-only keeps saved hosts working but admits none.
      if (!wslHostsGateOpen()) {
        return { ok: false, kind: 'disabled', message: WSL_HOSTS_NEW_WORK_PAUSED_MESSAGE }
      }
      const result = await wsl.add(request)
      if (result.ok) {
        noteWslHostUserAction({ kind: 'added', distro: request.distro })
      }
      return result
    }
  )
  ipcMain.handle('wslHosts:remove', async (_event, request: { environmentId: string }) => {
    if (args.store.getSettings().activeRuntimeEnvironmentId === request.environmentId) {
      throw new Error(
        'This server is the default host for new projects. Choose another one under New projects open on before removing it.'
      )
    }
    return wsl.remove(request.environmentId)
  })
  ipcMain.handle(
    'wslHosts:connect',
    (
      _event,
      request: { environmentId: string; intent?: unknown; withdrawPendingRemoval?: unknown }
    ) => wsl.connect(request.environmentId, wslHostConnectOptions(request))
  )
  ipcMain.handle('wslHosts:getCapability', (): WslHostCapability => ({
    serverFiles: wsl.hasServerFiles()
  }))
  ipcMain.handle('wslHosts:getStatuses', () => wsl.getStatuses())
  const visibleWork = new WslHostVisibleWorkByWindow()
  ipcMain.handle('wslHosts:setVisibleWork', (event, request: { environmentIds: string[] }) => {
    const sender = event.sender
    const windowId = sender.id
    const ids = Array.isArray(request.environmentIds) ? request.environmentIds : []
    if (!visibleWork.has(windowId)) {
      sender.once('destroyed', () => wsl.setVisibleWork(visibleWork.forget(windowId)))
    }
    wsl.setVisibleWork(visibleWork.report(windowId, ids))
  })
  // The user switched to a workspace on this host: the focus entry that may boot its distro.
  ipcMain.handle('wslHosts:focusHost', (_event, request: { environmentId: string | null }) => {
    // null: the user is on a workspace that isn't on a WSL host.
    wsl.focusHost(typeof request?.environmentId === 'string' ? request.environmentId : null)
  })
}
