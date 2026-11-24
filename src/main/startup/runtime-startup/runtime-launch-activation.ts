import { getLocalPtyProvider } from '../../ipc/pty/provider/registry'
import { LocalPtyProvider } from '../../providers/local-pty/local-pty-provider'
import { settleServeDesktopActivation } from '../serve-launch/serve-desktop-activation'
import { mainProcessState as state } from '../main-process-state'

export function settleDesktopActivation(): void {
  const gate = state.desktopActivationGate
  if (!gate) {
    return
  }
  settleServeDesktopActivation(gate, {
    hasPersistentPtyProvider: !(getLocalPtyProvider() instanceof LocalPtyProvider)
  })
}
