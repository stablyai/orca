/**
 * The wrapper files the daemon launches shells with, built against a
 * caller-supplied root so the tree can be content-addressed (see
 * shell-wrapper-content-address.ts).
 */
import { join } from 'node:path'
import { ZSH_WRAPPER_DIR_MARKER_CONTENT, ZSH_WRAPPER_DIR_MARKER_FILE } from '../shell-templates'
import type { ShellWrapperFile } from '../shell-wrapper-file-writer'
import { buildZshStartupWrapperFiles } from '../zsh-startup-wrapper-builder'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import { getDaemonZshWrapperSpec } from './daemon-zsh-shell-ready-wrapper-spec'

export function buildDaemonShellReadyWrapperFiles(root: string): readonly ShellWrapperFile[] {
  const zshDir = join(root, 'zsh')
  const zsh = buildZshStartupWrapperFiles(getDaemonZshWrapperSpec(zshDir))
  return [
    [join(zshDir, '.zshenv'), zsh.zshenv],
    [join(zshDir, '.zprofile'), zsh.zprofile],
    [join(zshDir, '.zshrc'), zsh.zshrc],
    [join(zshDir, '.zlogin'), zsh.zlogin],
    [join(zshDir, ZSH_WRAPPER_DIR_MARKER_FILE), ZSH_WRAPPER_DIR_MARKER_CONTENT],
    [join(root, 'bash', 'rcfile'), getDaemonBashShellReadyRcfileContent()]
  ]
}
