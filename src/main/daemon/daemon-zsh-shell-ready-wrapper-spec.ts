import type { ZshStartupWrapperSpec } from '../zsh-startup-wrapper-builder'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'

/** The zsh wrapper the daemon (local fork and SSH host) launches shells with. */
export function getDaemonZshWrapperSpec(zshDir: string): ZshStartupWrapperSpec {
  return {
    headerLabel: 'Orca daemon zsh shell-ready wrapper',
    zshDir,
    zshenvStrategy: 'discover-user-zdotdir',
    readyMarkerEscaped: SHELL_READY_MARKER,
    osc133CommandMarkers: true,
    skipUserZshrcWhenHomeIsWrapperDir: true,
    overlayRestoreComment:
      "# Why: ~/.zshrc can export the user's default OpenCode config after spawn.",
    restores: {
      agentTeamsPath: true,
      remoteCliBinDir: false,
      codexHome: true,
      codexLaunchPreflight: true
    }
  }
}
