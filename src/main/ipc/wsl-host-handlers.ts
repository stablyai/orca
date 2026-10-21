/**
 * IPC for WSL hosts (WSL-via-orcad C7); Windows only, or an e2e fake on any OS, and only with the
 * internal gate open.
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  WSL_HOST_STATUS_CHANNEL,
  type WslHostAddResult,
  type WslHostCapability,
  type WslHostStatus
} from '../../shared/wsl-host-types'
import type { Store } from '../persistence'
import { createWslHostConnector } from '../wsl/wsl-host-connector'
import {
  createFakeWslHostConnector,
  readFakeWslHostsConfig
} from '../wsl/wsl-host-e2e-fake-connector'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { WslHostService } from '../wsl/wsl-host-service'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
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

export const WSL_HOST_HANDLER_CHANNELS = [
  'wslHosts:listDistros',
  'wslHosts:add',
  'wslHosts:remove',
  'wslHosts:connect',
  'wslHosts:getStatuses',
  'wslHosts:setVisibleWork',
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

/** Removal reaches orcad the way every other call to the host does: by environment id. */
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
  // Closed gate: no service, so no holder adoption, wsl.exe spawn or reconnect can start.
  if (!wslHostsGateOpen()) {
    return null
  }
  const fake = readFakeWslHostsConfig()
  if (process.platform !== 'win32' && !fake) {
    return null
  }
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
    },
    removed: (environmentId) =>
      retireRemovedRuntimeEnvironment(environmentId, args.invalidateTransport, args.store)
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

export function registerWslHostHandlers(args: WslHostHandlerArgs): void {
  for (const channel of WSL_HOST_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  // Why none at all: without a service (gate closed, or not Windows) the preload exposes no API.
  const wsl = getWslHostService() ?? startService(args)
  if (!wsl) {
    return
  }
  ipcMain.handle('wslHosts:listDistros', () => wsl.listDistros())
  ipcMain.handle(
    'wslHosts:add',
    (_event, request: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> =>
      wsl.add(request)
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
    (_event, request: { environmentId: string; force?: boolean }) =>
      wsl.connect(request.environmentId, { force: request.force === true })
  )
  ipcMain.handle('wslHosts:getCapability', (): WslHostCapability => ({
    serverFiles: wsl.hasServerFiles()
  }))
  ipcMain.handle('wslHosts:getStatuses', () => wsl.getStatuses())
  ipcMain.handle('wslHosts:setVisibleWork', (_event, request: { environmentIds: string[] }) => {
    wsl.setVisibleWork(Array.isArray(request.environmentIds) ? request.environmentIds : [])
  })
}
