/**
 * The wrapper files main's local PTY path launches shells with, built against a
 * caller-supplied root so the tree can be content-addressed (see
 * shell-wrapper-content-address.ts).
 */
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import type { ShellWrapperFile } from '../shell-wrapper-file-writer'
import { buildZshStartupHook, type ZshStartupHookSpec } from '../zsh-startup-wrapper-builder'
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

/** Paths in the generated tree, kept separate so existence checks do not rebuild wrapper bytes. */
export function getLocalShellReadyWrapperPaths(root: string): readonly string[] {
  const zshDir = `${root}/zsh`
  return [`${zshDir}/.zshenv`, `${zshDir}/${ZSH_WRAPPER_DIR_MARKER_FILE}`, `${root}/bash/rcfile`]
}

export function getLocalZshWrapperSpec(): ZshStartupHookSpec {
  return {
    headerLabel: 'Orca zsh shell-ready wrapper',
    readyMarkerEscaped: SHELL_READY_MARKER_ESCAPED,
    osc133CommandMarkers: true,
    startupCommandDelivery: true,
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
// Why only .zshenv: the hook hands ZDOTDIR back on its first lines, so zsh reads
// .zprofile, .zshrc and .zlogin from the user's own directory. Nothing Orca
// writes is read after this file.
export function buildLocalShellReadyWrapperFiles(root: string): readonly ShellWrapperFile[] {
  const [zshEnvPath, zshMarkerPath, bashRcfilePath] = getLocalShellReadyWrapperPaths(root)
  return [
    [zshEnvPath, buildZshStartupHook(getLocalZshWrapperSpec())],
    [zshMarkerPath, ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [bashRcfilePath, getBashShellReadyRcfileContent()]
  ]
}
