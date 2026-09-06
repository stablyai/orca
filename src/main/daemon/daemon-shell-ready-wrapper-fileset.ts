/**
 * The wrapper files the daemon launches shells with, built against a
 * caller-supplied root so the tree can be content-addressed (see
 * shell-wrapper-content-address.ts).
 */
import { join } from 'node:path'
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import type { ShellWrapperFile } from '../shell-wrapper-file-writer'
import { buildZshStartupHook } from '../zsh-startup-wrapper-builder'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import { getDaemonZshWrapperSpec } from './daemon-zsh-shell-ready-wrapper-spec'

/** Paths in the generated tree, kept separate so existence checks do not rebuild wrapper bytes. */
export function getDaemonShellReadyWrapperPaths(root: string): readonly string[] {
  const zshDir = join(root, 'zsh')
  return [
    join(zshDir, '.zshenv'),
    join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE),
    join(root, 'bash', 'rcfile')
  ]
}

// Why only .zshenv: the hook hands ZDOTDIR back on its first lines, so zsh reads
// .zprofile, .zshrc and .zlogin from the user's own directory. Nothing Orca
// writes is read after this file.
export function buildDaemonShellReadyWrapperFiles(root: string): readonly ShellWrapperFile[] {
  const [zshEnvPath, zshMarkerPath, bashRcfilePath] = getDaemonShellReadyWrapperPaths(root)
  return [
    [zshEnvPath, buildZshStartupHook(getDaemonZshWrapperSpec())],
    [zshMarkerPath, ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [bashRcfilePath, getDaemonBashShellReadyRcfileContent()]
  ]
}
