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
  // The hash names exact wrapper bytes; reuse a nonempty tree rather than replace files live on the spawn path.
  if (!shellReadyWrappersExist(root)) {
    const written = writeShellWrapperFiles(buildLocalShellReadyWrapperFiles(root), '[shell-ready]')
    if (!written || !shellReadyWrappersExist(root)) {
      // File checks retry partial writes on the next launch without a persistent success flag.
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
