/**
 * On-disk layout of the generated shell-ready wrapper files, plus the marker the
 * wrappers emit — the shared contract between wrapper generation and shell launch.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { resolveShellWrapperRoot } from '../shell-wrapper-content-address'
import {
  buildLocalShellReadyWrapperFiles,
  getLocalShellReadyWrapperPaths
} from './local-pty-shell-ready-wrapper-fileset'

export { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

// Module-private, matching the daemon's twin: nothing outside needs the base.
function getShellReadyWrapperBaseDir(): string {
  // Why: bundled into the daemon fork (no electron), so read ORCA_USER_DATA_PATH rather than electron's userData; main and the fork both set it to the same path.
  // Why a truthiness test rather than `??`: a set-but-empty ORCA_USER_DATA_PATH
  // would leave a relative base dir, so wrapper trees would be written under
  // whatever the process cwd happens to be.
  const userDataPath = process.env.ORCA_USER_DATA_PATH
  // Why not the legacy `shell-ready/`: daemons of older builds still write that
  // path unconditionally, so this build's trees live out of their reach. Why the
  // fallback is namespaced: os.tmpdir() is a shared world-writable /tmp on
  // Linux, where a generic name is one any local user can pre-create and own.
  // Note the presence check is size-only, so a complete tree pre-planted under
  // that fallback would be trusted rather than overwritten. Production never
  // reaches it -- ORCA_USER_DATA_PATH is seeded before anything spawns and the
  // daemon fork inherits it -- so this stays a documented trust boundary rather
  // than an ownership check on the spawn path.
  return userDataPath ? join(userDataPath, 'shell-wrappers') : join(tmpdir(), 'orca-shell-wrappers')
}

// Why memoized: the digest is stable for a given base dir and every shell launch
// asks for it. Why keyed on the base dir rather than a bare flag: it
// self-invalidates if ORCA_USER_DATA_PATH is ever re-pointed mid-process.
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

/**
 * Every wrapper file exists and has content.
 *
 * Why non-empty and not just present: a partial write (full disk, killed mid
 * write) leaves a zero-byte .zshenv, and pointing ZDOTDIR at that directory
 * makes zsh skip the user's entire configuration silently.
 */
export function shellReadyWrappersExist(root = getShellReadyWrapperRoot()): boolean {
  return getRequiredShellReadyWrapperPaths(root).every((path) => {
    try {
      return statSync(path).size > 0
    } catch {
      return false
    }
  })
}
