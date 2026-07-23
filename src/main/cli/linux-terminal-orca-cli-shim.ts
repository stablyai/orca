import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFileContentsEqualSync } from '../../shared/node-file-content-equality'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import { buildBareOrcaCliScript } from './linux-bare-orca-dispatcher'

const SHIM_DIR_NAME = 'linux-orca-cli-shim'

// Why: rewriting the shim on every PTY spawn is wasted fs work; the target only
// changes with the install itself, so one successful write per process is enough.
// Failures are NOT cached so a transient fs error retries on the next spawn.
const ensuredShimDirs = new Map<string, string>()
export const LINUX_TERMINAL_SHIM_CACHE_MAX_ENTRIES = 64
export const LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES = 64 * 1024

function getEnsuredShimDir(userDataPath: string): string | undefined {
  const cached = ensuredShimDirs.get(userDataPath)
  if (cached === undefined) {
    return undefined
  }
  ensuredShimDirs.delete(userDataPath)
  ensuredShimDirs.set(userDataPath, cached)
  return cached
}

function rememberEnsuredShimDir(userDataPath: string, shimDir: string): void {
  if (
    measureUtf8ByteLength(userDataPath, {
      stopAfterBytes: LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES
    }).exceededLimit
  ) {
    return
  }
  ensuredShimDirs.delete(userDataPath)
  ensuredShimDirs.set(userDataPath, shimDir)
  while (ensuredShimDirs.size > LINUX_TERMINAL_SHIM_CACHE_MAX_ENTRIES) {
    const oldest = ensuredShimDirs.keys().next().value
    if (oldest === undefined) {
      return
    }
    ensuredShimDirs.delete(oldest)
  }
}

export type LinuxTerminalOrcaCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Test seam — defaults to $APPIMAGE (set only when running from an AppImage). */
  appImagePath?: string | null
}

// Why: on Linux the CLI installs as `orca-ide` so it never shadows the GNOME
// Orca screen reader at /usr/bin/orca — but agent-facing surfaces (skills,
// dispatch preambles, CLI hints) all invoke bare `orca`, so on stock Ubuntu an
// agent inside an Orca terminal would launch the screen reader instead
// (stablyai/orca#7904). Prepending this userData-scoped shim dir to managed-PTY
// PATH makes bare `orca` resolve to the Orca CLI inside Orca terminals only,
// leaving the user's own shells (and their screen reader) untouched.
export function ensureLinuxTerminalOrcaCliShimDir(
  options: LinuxTerminalOrcaCliShimOptions
): string | null {
  const cached = getEnsuredShimDir(options.userDataPath)
  if (cached !== undefined) {
    return cached
  }

  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) {
    return null
  }
  const resolved = buildBareOrcaCliScript(
    resourcesPath,
    options.appImagePath ?? process.env.APPIMAGE ?? null
  )
  if (!resolved) {
    return null
  }

  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'orca')
  try {
    if (!shimMatches(shimPath, resolved.script)) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, resolved.script, 'utf8')
    }
    // Why: always re-assert the exec bit — a shim written by an older run (or
    // restored from backup) with mode stripped would fail every agent CLI call.
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  rememberEnsuredShimDir(options.userDataPath, shimDir)
  return shimDir
}

export function _resetLinuxTerminalShimCacheForTests(): void {
  ensuredShimDirs.clear()
}

export function _getLinuxTerminalShimCacheSizeForTests(): number {
  return ensuredShimDirs.size
}

export function _isLinuxTerminalShimCacheKeyRetainableForTests(userDataPath: string): boolean {
  return !measureUtf8ByteLength(userDataPath, {
    stopAfterBytes: LINUX_TERMINAL_SHIM_CACHE_KEY_MAX_BYTES
  }).exceededLimit
}

function shimMatches(shimPath: string, expected: string): boolean {
  try {
    return nodeFileContentsEqualSync(shimPath, expected)
  } catch {
    return false
  }
}
