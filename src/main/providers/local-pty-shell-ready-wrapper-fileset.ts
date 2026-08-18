/**
 * The wrapper files main's local PTY path launches shells with, built against a
 * caller-supplied root so the tree can be content-addressed (see
 * shell-wrapper-content-address.ts).
 */
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import type { ShellWrapperFile } from '../shell-wrapper-file-writer'
import {
  buildZshStartupWrapperFiles,
  type ZshStartupWrapperSpec
} from '../zsh-startup-wrapper-builder'
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

export function getLocalZshWrapperSpec(zshDir: string): ZshStartupWrapperSpec {
  return {
    headerLabel: 'Orca zsh shell-ready wrapper',
    zshDir,
    zshenvStrategy: 'discover-user-zdotdir',
    readyMarkerEscaped: SHELL_READY_MARKER_ESCAPED,
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

// Why `/` concatenation rather than path.join: these paths are baked into
// .zshenv as a shell literal and handed to bash as `--rcfile`, and the launch
// config builds the matching values the same way (local-pty-shell-ready.ts).
// path.join would emit backslashes on Windows, where a shell literal reads them
// as escapes -- and would desync the written path from the launched one.
export function buildLocalShellReadyWrapperFiles(root: string): readonly ShellWrapperFile[] {
  const zshDir = `${root}/zsh`
  const zsh = buildZshStartupWrapperFiles(getLocalZshWrapperSpec(zshDir))
  return [
    [`${zshDir}/.zshenv`, zsh.zshenv],
    [`${zshDir}/.zprofile`, zsh.zprofile],
    [`${zshDir}/.zshrc`, zsh.zshrc],
    [`${zshDir}/.zlogin`, zsh.zlogin],
    [`${zshDir}/${ZSH_WRAPPER_DIR_MARKER_FILE}`, ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [`${root}/bash/rcfile`, getBashShellReadyRcfileContent()]
  ]
}
