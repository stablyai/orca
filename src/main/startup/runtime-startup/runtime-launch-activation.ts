import { app } from 'electron'
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

/** E2E only: a serve host with no browser of its own, as the WSL distro's server is. Never packaged. */
export function e2eHeadlessServeWithoutBrowser(): boolean {
  return (
    !app.isPackaged &&
    process.env.ORCA_E2E_HEADLESS === '1' &&
    process.env.ORCA_E2E_HEADLESS_SERVE_WITHOUT_BROWSER === '1'
  )
}
