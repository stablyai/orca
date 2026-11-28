/** A paired server's ports forwarded to this computer; desktop-only, so web clients leave it undefined. */
import { ipcRenderer } from 'electron'
import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import {
  RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL,
  type RestoredPortForwardMove,
  type RuntimeEnvironmentPortForwardsChanged
} from '../../../shared/remote-runtime/host-catalog/runtime-environment-port-forward-channel'

type RuntimePortForwardSpec = {
  environmentId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export type RuntimePortForwardsPreloadApi = {
  /** Every paired server's forwards; each entry's connectionId is its server's environment id. */
  list: () => Promise<PortForwardEntry[]>
  add: (args: RuntimePortForwardSpec) => Promise<PortForwardEntry>
  update: (args: RuntimePortForwardSpec & { id: string }) => Promise<PortForwardEntry>
  remove: (args: { id: string }) => Promise<boolean>
  /** The server localhost port's forward, started on the same port number here when free.
   *  `session`: one emulator attach whose own forward this is, never shared or saved; it closes
   *  when the session ends or this window reloads. */
  ensure: (args: {
    environmentId: string
    remotePort: number
    label?: string
    session?: string
  }) => Promise<{ entry: PortForwardEntry; created: boolean }>
  /** Ends a session: its forwards close and a pending ensure for it opens nothing. */
  endSession: (args: { session: string }) => Promise<void>
  /** Restored forwards that moved off a busy port here; each is returned to one caller, once. */
  takeRestoredMoves: () => Promise<RestoredPortForwardMove[]>
  onChanged: (callback: (event: RuntimeEnvironmentPortForwardsChanged) => void) => () => void
}

export const runtimePortForwardsApi: RuntimePortForwardsPreloadApi = {
  list: () => ipcRenderer.invoke('runtimeEnvironments:listPortForwards'),
  add: (args) => ipcRenderer.invoke('runtimeEnvironments:addPortForward', args),
  update: (args) => ipcRenderer.invoke('runtimeEnvironments:updatePortForward', args),
  remove: (args) => ipcRenderer.invoke('runtimeEnvironments:removePortForward', args),
  ensure: (args) => ipcRenderer.invoke('runtimeEnvironments:ensurePortForward', args),
  endSession: (args) => ipcRenderer.invoke('runtimeEnvironments:endPortForwardSession', args),
  takeRestoredMoves: () => ipcRenderer.invoke('runtimeEnvironments:takeRestoredPortForwardMoves'),
  onChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: RuntimeEnvironmentPortForwardsChanged
    ): void => callback(data)
    ipcRenderer.on(RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL, listener)
    return () =>
      ipcRenderer.removeListener(RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL, listener)
  }
}
