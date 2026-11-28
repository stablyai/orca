import type { ZshStartupHookSpec } from '../../pty/shell-startup/zsh-startup-wrapper-builder'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'

export function getDaemonZshWrapperSpec(): ZshStartupHookSpec {
  return {
    headerLabel: 'Orca daemon zsh shell-ready wrapper',
    readyMarkerEscaped: SHELL_READY_MARKER,
    osc133CommandMarkers: true,
    // The first zle line editor runs the launch line, so nothing is typed into a shell whose rc files may still read the TTY.
    startupCommandDelivery: true,
    overlayRestoreComment:
      "# Why: ~/.zshrc can export the user's default OpenCode config after spawn.",
    restores: {
      managedWslCli: false,
      agentTeamsPath: true,
      remoteCliBinDir: false,
      codexHome: true
    }
  }
}
