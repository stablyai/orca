import { BrowserWindow, ipcMain } from 'electron'
import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest,
  RuntimePortForwardReason
} from '../../../shared/runtime-port-forwards'
import { RUNTIME_PORT_FORWARDS_CHANGED_CHANNEL } from '../../../shared/runtime-port-forward-channels'
import {
  getRuntimePortForwardManager,
  installRuntimePortForwardManager,
  RuntimePortForwardManager
} from '../../runtime-port-forward/runtime-port-forward-manager'
import {
  createPortForwardConnector,
  type PortForwardTunnelConnector
} from '../../runtime-port-forward/runtime-port-forward-tunnel'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { prepareRecipeVm } from './runtime-environment-recipe-vm-wake'

function createPairedRuntimePortForwardConnector(
  getUserDataPath: () => string
): PortForwardTunnelConnector {
  return createPortForwardConnector(async (environmentId) => {
    const userDataPath = getUserDataPath()
    // Wake-first: a connection to a sleeping VM wakes it (held up to the open timeout) instead of failing.
    await prepareRecipeVm(userDataPath, resolveEnvironment(userDataPath, environmentId), 'wake')
    await ensureOrcadManagedTunnel(userDataPath, environmentId)
    return getPreferredPairedRuntimeConnection(resolveEnvironment(userDataPath, environmentId))
  })
}

function broadcast(forwards: RuntimePortForward[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(RUNTIME_PORT_FORWARDS_CHANGED_CHANNEL, forwards)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined
}

// The renderer may ask for user or auto forwards; SSH forwards belong to main-process callers.
function requestOf(value: unknown): RuntimePortForwardOpenRequest | null {
  const environmentId = field(value, 'environmentId')
  const remotePort = field(value, 'remotePort')
  const localPort = field(value, 'localPort')
  const reason = field(value, 'reason')
  const label = field(value, 'label')
  const exclusive = field(value, 'exclusive')
  if (
    typeof environmentId !== 'string' ||
    typeof remotePort !== 'number' ||
    (localPort !== undefined && typeof localPort !== 'number') ||
    (reason !== 'user' && reason !== 'auto')
  ) {
    return null
  }
  return {
    environmentId,
    remotePort,
    ...(localPort !== undefined ? { localPort } : {}),
    reason: reason satisfies RuntimePortForwardReason,
    ...(typeof label === 'string' && label ? { label: label.slice(0, 120) } : {}),
    ...(exclusive === true ? { exclusive: true } : {})
  }
}

export function registerRuntimePortForwardHandlers(getUserDataPath: () => string): void {
  if (!getRuntimePortForwardManager()) {
    installRuntimePortForwardManager(
      new RuntimePortForwardManager({
        connector: createPairedRuntimePortForwardConnector(getUserDataPath),
        onChange: broadcast,
        log: (message) => console.info(message)
      })
    )
  }
  const manager = (): RuntimePortForwardManager => getRuntimePortForwardManager()!
  ipcMain.handle('runtimePortForwards:list', () => manager().list())
  ipcMain.handle('runtimePortForwards:open', (_event, value: unknown) => {
    const request = requestOf(value)
    return request
      ? manager().open(request)
      : { ok: false, code: 'invalid_request', message: 'Invalid port forward.' }
  })
  ipcMain.handle('runtimePortForwards:wake', (_event, value: unknown) => {
    const environmentId = field(value, 'environmentId')
    return typeof environmentId === 'string' ? manager().wake(environmentId) : false
  })
  ipcMain.handle('runtimePortForwards:close', (_event, value: unknown) => {
    const id = field(value, 'id')
    return typeof id === 'string' ? manager().close(id) : null
  })
}

export const RUNTIME_PORT_FORWARD_HANDLER_CHANNELS = [
  'runtimePortForwards:list',
  'runtimePortForwards:open',
  'runtimePortForwards:close',
  'runtimePortForwards:wake'
] as const
