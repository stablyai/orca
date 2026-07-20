// Discovers alternate Claude config dirs (`~/.claude-<name>` / `~/.claude.<name>`)
// so Orca can install its managed status hooks into each of them. A genuine
// claude launched with `CLAUDE_CONFIG_DIR=$HOME/.claude-<name>` (a common
// wrapper pattern for alternate endpoints) only loads hooks from that dir.
//
// Privacy: these dirs hold credentials. Discovery is readdir + stat ONLY —
// file contents are never read, and dir listings / entry names are never
// logged.

import { existsSync, readdirSync } from 'node:fs'
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
  /** stat-based existence probe; must not read file contents. */
  pathExists(path: string): boolean
}

const localNodeFs: LocalClaudeConfigDirFs = {
  readdirNames: (dirPath) => readdirSync(dirPath),
  pathExists: (path) => existsSync(path)
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
      return fs.pathExists(join(homeDir, name, marker))
    } catch {
      return false
    }
  })
}

/** Callback-shape subset shared by ssh2's SFTPWrapper and the WSL hook fs
 *  adapter — structural so discovery runs over either transport unchanged. */
export type SftpShapedClaudeConfigDirFs = {
  readdir(path: string, callback: (err: unknown, entries?: { filename: string }[]) => void): void
  stat(path: string, callback: (err: unknown, stats?: unknown) => void): void
}

// Why: mirror installer-utils-remote's per-operation timeout — a wedged SFTP
// callback must degrade discovery to "no extra dirs", not hang remote startup.
const REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS = 10_000

function remoteOperation<T>(
  run: (callback: (err: unknown, value?: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('Timed out waiting for SFTP config-dir discovery'))
      }
    }, REMOTE_DISCOVERY_OPERATION_TIMEOUT_MS)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    const finish = (err: unknown, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (err) {
        reject(err)
        return
      }
      resolve(value as T)
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
  remoteHome: string
): Promise<string[]> {
  const home = remoteHome.replace(/\/+$/, '') || '/'
  let entries: { filename: string }[]
  try {
    entries = await remoteOperation<{ filename: string }[]>((callback) => {
      sftp.readdir(home, (err, list) => callback(err, list ?? []))
    })
  } catch {
    return []
  }
  const candidates = entries
    .map((entry) => entry.filename)
    .filter(isClaudeFlavorConfigDirName)
    .sort()
  const discovered: string[] = []
  for (const name of candidates) {
    const dirPath = home === '/' ? `/${name}` : `${home}/${name}`
    for (const marker of CLAUDE_CONFIG_DIR_MARKERS) {
      const present = await remoteOperation<boolean>((callback) => {
        sftp.stat(`${dirPath}/${marker}`, (err) => callback(null, !err))
      }).catch(() => false)
      if (present) {
        discovered.push(name)
        break
      }
    }
  }
  return discovered
}
