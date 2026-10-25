import { join } from 'node:path'
import {
  buildFishVendorConfWrapperFile,
  getFishVendorConfSnippetPath
} from '../fish-xdg-data-dirs-handoff'
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import type { ShellWrapperFile } from '../shell-wrapper-file-writer'
import { buildZshStartupHook } from '../zsh-startup-wrapper-builder'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import { getDaemonZshWrapperSpec } from './daemon-zsh-shell-ready-wrapper-spec'

/** Let existence checks avoid regenerating wrapper bytes. */
export function getDaemonShellReadyWrapperPaths(root: string): readonly string[] {
  const zshDir = join(root, 'zsh')
  return [
    join(zshDir, '.zshenv'),
    join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE),
    join(root, 'bash', 'rcfile'),
    getFishVendorConfSnippetPath(root)
  ]
}

// The .zshenv hook restores ZDOTDIR so later startup files come from the user's directory.
export function buildDaemonShellReadyWrapperFiles(root: string): readonly ShellWrapperFile[] {
  const [zshEnvPath, zshMarkerPath, bashRcfilePath] = getDaemonShellReadyWrapperPaths(root)
  return [
    [zshEnvPath, buildZshStartupHook(getDaemonZshWrapperSpec())],
    [zshMarkerPath, ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [bashRcfilePath, getDaemonBashShellReadyRcfileContent()],
    buildFishVendorConfWrapperFile(root)
  ]
}
