// Discovers alternate Claude config dirs (`~/.claude-<name>` / `~/.claude.<name>`)
// so Orca can install its managed status hooks into each of them. A genuine
// claude launched with `CLAUDE_CONFIG_DIR=$HOME/.claude-<name>` (a common
// wrapper pattern for alternate endpoints) only loads hooks from that dir.
//
// Privacy: these dirs hold credentials. Discovery is readdir + stat ONLY —
// file contents are never read, and dir listings / entry names are never
// logged.

import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_FLAVOR_CONFIG_DIR_PATTERN } from '../../shared/claude-config-dir-label'

/** Marker files whose PRESENCE (stat only) proves a matching home-dir entry is
 *  a Claude-shaped config directory rather than an unrelated dot-entry. */
export const CLAUDE_CONFIG_DIR_MARKERS = [
  'settings.json',
  '.claude.json',
  '.credentials.json'
] as const

// Why: these already have dedicated hook services; re-discovering them would
// double-install into the same settings.json.
const MANAGED_CONFIG_DIR_NAMES: ReadonlySet<string> = new Set(['.claude', '.openclaude'])

// Why: each candidate costs up to three synchronous local or sequential
// remote probes; cap both paths so a huge home cannot delay startup arbitrarily.
const CLAUDE_CONFIG_DIR_DISCOVERY_MAX_CANDIDATES = 16

export function isClaudeFlavorConfigDirName(name: string): boolean {
  if (MANAGED_CONFIG_DIR_NAMES.has(name) || name.includes('/') || name.includes('\\')) {
    return false
  }
  const suffix = CLAUDE_FLAVOR_CONFIG_DIR_PATTERN.exec(name)?.[1]
  // Why: ledger values may be tampered independently of readdir discovery.
  // Keep every accepted value a single safe path segment on all host OSes.
  return suffix !== undefined && suffix !== '.' && suffix !== '..'
}

export type LocalClaudeConfigDirFs = {
  /** Entry names of a directory. Callers must never log the result. */
  readdirNames(dirPath: string): string[]
  /** stat-based regular-file probe; must not read file contents. */
  pathIsFile(path: string): boolean
}

const localNodeFs: LocalClaudeConfigDirFs = {
  readdirNames: (dirPath) => readdirSync(dirPath),
  // Why: lstat — presence must not follow a marker symlink out of the dir.
  pathIsFile: (path) => lstatSync(path).isFile()
}

/** Discover flavor config dirs in the local home dir. Returns sorted dir
 *  names. Fails open (empty result) when the home dir cannot be listed. */
export function discoverLocalClaudeConfigDirNames(
  homeDir: string = homedir(),
  fs: LocalClaudeConfigDirFs = localNodeFs
): string[] {
  let names: string[]
  try {
    names = fs.readdirNames(homeDir)
  } catch {
    return []
  }
  return names
    .filter(isClaudeFlavorConfigDirName)
    .sort()
    .slice(0, CLAUDE_CONFIG_DIR_DISCOVERY_MAX_CANDIDATES)
    .filter((name) => hasLocalConfigDirMarker(homeDir, name, fs))
}

function hasLocalConfigDirMarker(
  homeDir: string,
  name: string,
  fs: LocalClaudeConfigDirFs
): boolean {
  // Why: a marker INSIDE the entry both proves it is a directory (a regular
  // file has no children, so the stat fails) and that a Claude-compatible CLI
  // actually populated it.
  return CLAUDE_CONFIG_DIR_MARKERS.some((marker) => {
    try {
      return fs.pathIsFile(join(homeDir, name, marker))
    } catch {
      return false
    }
  })
}

/** Callback-shape subset shared by ssh2's SFTPWrapper and the WSL hook fs
 *  adapter — structural so discovery runs over either transport unchanged. */
export type SftpShapedClaudeConfigDirFs = {
  readdir(path: string, callback: (err: unknown, entries?: { filename: string }[]) => void): void
  stat(
    path: string,
    callback: (err: unknown, stats?: { mode?: number; isFile?: () => boolean }) => void
  ): void
  /** No-follow probe used for markers when available (ssh2 has it); falls
   *  back to `stat` when absent. */
  lstat?(
    path: string,
    callback: (err: unknown, stats?: { mode?: number; isFile?: () => boolean }) => void
  ): void
}

function isRemoteRegularFile(
  stats: { mode?: number; isFile?: () => boolean } | undefined
): boolean {
  if (!stats) {
    return false
  }
  if (typeof stats.isFile === 'function') {
    return stats.isFile()
  }
  // Why: the WSL bridge serializes only POSIX mode bits, while ssh2 exposes isFile().
  return typeof stats.mode === 'number' && (stats.mode & 0o170000) === 0o100000
}

// Why: mirror installer-utils-remote's per-operation timeout — a wedged SFTP
// callback must degrade discovery to "no extra dirs", not hang remote startup.
const REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS = 10_000

// Why: a wedged SFTP probe still needs an overall deadline in addition to the
// shared candidate cap.
const REMOTE_DISCOVERY_DEADLINE_MS = 15_000

function remoteOperation<T>(
  run: (callback: (err: unknown, value?: T) => void) => void,
  timeoutMs = REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const finish = (err: unknown, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (err) {
        reject(err)
        return
      }
      resolve(value as T)
    }
    const abort = (): void => {
      try {
        signal?.throwIfAborted()
      } catch (error) {
        finish(error)
      }
    }
    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for SFTP config-dir discovery'))
    }, timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      run(finish)
    } catch (error) {
      finish(error)
    }
  })
}

/** Discover flavor config dirs under a POSIX remote `$HOME` over an SFTP-shaped
 *  transport (SSH or the WSL fs bridge). Fails open on listing errors. */
export async function discoverRemoteClaudeConfigDirNames(
  sftp: SftpShapedClaudeConfigDirFs,
  remoteHome: string,
  signal?: AbortSignal
): Promise<string[]> {
  const home = remoteHome.replace(/\/+$/, '') || '/'
  const deadline = Date.now() + REMOTE_DISCOVERY_DEADLINE_MS
  let entries: { filename: string }[]
  try {
    entries = await remoteOperation<{ filename: string }[]>(
      (callback) => {
        sftp.readdir(home, (err, list) => callback(err, list ?? []))
      },
      Math.min(REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS, REMOTE_DISCOVERY_DEADLINE_MS),
      signal
    )
  } catch {
    signal?.throwIfAborted()
    return []
  }
  const candidates = entries
    .map((entry) => entry.filename)
    .filter(isClaudeFlavorConfigDirName)
    .sort()
    .slice(0, CLAUDE_CONFIG_DIR_DISCOVERY_MAX_CANDIDATES)
  const markerProbe = sftp.lstat ?? sftp.stat
  const discovered: string[] = []
  for (const name of candidates) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) {
      break
    }
    const dirPath = home === '/' ? `/${name}` : `${home}/${name}`
    for (const marker of CLAUDE_CONFIG_DIR_MARKERS) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return discovered
      }
      let present = false
      try {
        present = await remoteOperation<boolean>(
          (callback) => {
            markerProbe.call(sftp, `${dirPath}/${marker}`, (err, stats) =>
              callback(null, !err && isRemoteRegularFile(stats))
            )
          },
          Math.min(REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS, remainingMs),
          signal
        )
      } catch {
        signal?.throwIfAborted()
      }
      if (present) {
        discovered.push(name)
        break
      }
    }
  }
  return discovered
}
