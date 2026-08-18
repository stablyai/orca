/**
 * Generates the zsh ZDOTDIR tree and bash rcfile Orca launches shells with.
 *
 * Why: the wrappers emit an OSC 777 marker after startup files finish, which the
 * readiness scanner watches for before a startup command is written.
 */
import { buildZshStartupHook } from '../zsh-startup-wrapper-builder'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import {
  buildLocalShellReadyWrapperFiles,
  getLocalZshWrapperSpec
} from './local-pty-shell-ready-wrapper-fileset'
import {
  getShellReadyWrapperRoot,
  shellReadyWrappersExist
} from './local-pty-shell-ready-wrapper-root'

export function getZshShellReadyWrapperFile(): string {
  return buildZshStartupHook(getLocalZshWrapperSpec())
}

/** True when every wrapper file is present and non-empty afterwards. */
export function ensureShellReadyWrappersAt(root = getShellReadyWrapperRoot()): boolean {
  // Why existence alone decides, with no per-process flag: the root is keyed by
  // a hash of the exact bytes we would write, so a tree that is present and
  // non-empty is a tree this build wrote. Rewriting it would replace a live file
  // on the terminal-spawn path for no gain.
  if (!shellReadyWrappersExist(root)) {
    const written = writeShellWrapperFiles(buildLocalShellReadyWrapperFiles(root), '[shell-ready]')
    if (!written || !shellReadyWrappersExist(root)) {
      // Why no flag to reset: the next launch re-checks the files themselves, so
      // a half-written tree is retried without any extra bookkeeping.
      return false
    }
  }

  return true
}

export function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  return ensureShellReadyWrappersAt()
}
