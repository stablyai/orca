import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { resolveShellWrapperRoot } from '../shell-wrapper-content-address'
import {
  buildLocalShellReadyWrapperFiles,
  getLocalShellReadyWrapperPaths
} from './local-pty-shell-ready-wrapper-fileset'

export { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

function getShellReadyWrapperBaseDir(): string {
  // Plain-node daemon forks share ORCA_USER_DATA_PATH with main; empty values must fall back, never form relative roots.
  const userDataPath = process.env.ORCA_USER_DATA_PATH
  // Avoid legacy shell-ready/ trees still overwritten by old daemons.
  // The temp fallback trusts nonempty preplanted files; production must seed ORCA_USER_DATA_PATH before spawning.
  return userDataPath ? join(userDataPath, 'shell-wrappers') : join(tmpdir(), 'orca-shell-wrappers')
}

// Cache by base directory so changing ORCA_USER_DATA_PATH invalidates the digest.
let cachedShellReadyWrapperRoot: { baseDir: string; root: string } | null = null

export function getShellReadyWrapperRoot(): string {
  const baseDir = getShellReadyWrapperBaseDir()
  if (cachedShellReadyWrapperRoot?.baseDir !== baseDir) {
    cachedShellReadyWrapperRoot = {
      baseDir,
      root: resolveShellWrapperRoot(baseDir, buildLocalShellReadyWrapperFiles)
    }
  }
  return cachedShellReadyWrapperRoot.root
}

export function getRequiredShellReadyWrapperPaths(
  root = getShellReadyWrapperRoot()
): readonly string[] {
  return getLocalShellReadyWrapperPaths(root)
}

/** Zero-byte partial wrappers would silently bypass the user config; presence alone is insufficient. */
export function shellReadyWrappersExist(root = getShellReadyWrapperRoot()): boolean {
  return getRequiredShellReadyWrapperPaths(root).every((path) => {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  })
}
