import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  CODEX_HOOK_FLAG_ENTRY_SUFFIX,
  CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX,
  CODEX_HOOK_FLAG_REQUEST_SUFFIX
} from '../../shared/codex-shell-function'
import { getOrcaUserDataPath } from './codex-home-paths'

/**
 * Orca's published Codex hook flags, one entry per `codex --version` output.
 * A pane carries only this directory's path, and every launch reads the entry
 * for its own binary's version then, so an entry published after the pane
 * opened, or removed by the opt-out, takes effect at that pane's next launch.
 * Per userData directory, whose active profile's setting decides, so a dev
 * and a packaged Orca never strip each other's panes. The directory exists
 * exactly while Codex hooks are on, so a launch without it runs plain codex
 * with no probe at all. Every delete here is best-effort: bookkeeping never
 * stops Orca from starting or the opt-out from finishing.
 *
 *   <version>.flag       the `-c` value, one line
 *   <version>.no-daemon  present when that Codex accepts --no-daemon
 *   <version>.request    a launch found no entry; holds its codex path, if known
 */
export type CodexHookFlagEntry = {
  codexVersion: string
  flag: string
  noDaemon: boolean
}

type CodexHookFlagRequest = {
  codexVersion: string
  /** Absolute path of the requesting launch's codex; null when the carrier could not tell. */
  codexPath: string | null
}

// Why this shape: every carrier names the file after the version it read.
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,126}[A-Za-z0-9]$/

export function getCodexHookFlagTablePath(): string {
  return join(getOrcaUserDataPath(), 'codex-hook-flags')
}

export function isCodexHookFlagEntryName(codexVersion: string): boolean {
  return ENTRY_NAME.test(codexVersion)
}

export function createCodexHookFlagTable(table = getCodexHookFlagTablePath()): void {
  mkdirSync(table, { recursive: true })
}

export function codexHookFlagTableExists(table = getCodexHookFlagTablePath()): boolean {
  return existsSync(table)
}

// Why retries: a Windows carrier or a virus scan can hold a file open for a moment.
const RM_OPTIONS = { force: true, maxRetries: 3 } as const

/** False when the directory could not be removed; it is logged, never thrown. */
export function removeCodexHookFlagTable(table = getCodexHookFlagTablePath()): boolean {
  try {
    rmSync(table, { ...RM_OPTIONS, recursive: true })
    return true
  } catch (error) {
    console.warn('[codex-hook-session] could not remove the Codex hook flag table:', error)
    return false
  }
}

function removeFile(path: string): void {
  try {
    rmSync(path, RM_OPTIONS)
  } catch (error) {
    console.warn('[codex-hook-session] could not remove a Codex hook flag file:', error)
  }
}

function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function readFirstLine(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').split(/\r?\n/)[0] ?? ''
  } catch {
    return null
  }
}

function fileExists(path: string): boolean {
  return readFirstLine(path) !== null
}

export function readCodexHookFlagEntry(
  codexVersion: string,
  table = getCodexHookFlagTablePath()
): CodexHookFlagEntry | null {
  if (!isCodexHookFlagEntryName(codexVersion)) {
    return null
  }
  const base = join(table, codexVersion)
  const flag = readFirstLine(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`)
  return flag
    ? {
        codexVersion,
        flag,
        noDaemon: fileExists(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`)
      }
    : null
}

function listNames(table: string, suffix: string): string[] {
  try {
    return readdirSync(table)
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length))
  } catch {
    return []
  }
}

export function listCodexHookFlagEntries(
  table = getCodexHookFlagTablePath()
): CodexHookFlagEntry[] {
  return listNames(table, CODEX_HOOK_FLAG_ENTRY_SUFFIX).flatMap((codexVersion) => {
    const entry = readCodexHookFlagEntry(codexVersion, table)
    return entry ? [entry] : []
  })
}

function writeAtomically(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, content, 'utf-8')
    renameSync(temp, path)
  } catch (error) {
    removeFile(temp)
    throw error
  }
}

/**
 * Marker first, so a launch that sees the flag also sees whether --no-daemon
 * applies. False when the table is gone: publishing never re-enables hooks.
 */
export function publishCodexHookFlagEntry(
  entry: CodexHookFlagEntry,
  table = getCodexHookFlagTablePath()
): boolean {
  if (!isCodexHookFlagEntryName(entry.codexVersion) || /[\r\n]/.test(entry.flag)) {
    throw new Error(`Cannot publish a Codex hook flag for ${JSON.stringify(entry.codexVersion)}`)
  }
  if (!existsSync(table)) {
    return false
  }
  const base = join(table, entry.codexVersion)
  if (entry.noDaemon) {
    writeFileSync(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`, '', 'utf-8')
  } else {
    removeFile(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`)
  }
  writeAtomically(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`, `${entry.flag}\n`)
  return true
}

export function removeCodexHookFlagEntry(
  codexVersion: string,
  table = getCodexHookFlagTablePath()
): void {
  const base = join(table, codexVersion)
  removeFile(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`)
  removeFile(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`)
}

/**
 * Drops every entry `keep` rejects, then all but the `cap` newest, so the
 * table never keeps an old definition or grows with every Codex version seen.
 */
export function pruneCodexHookFlagEntries(
  keep: (entry: CodexHookFlagEntry) => boolean,
  cap: number,
  table = getCodexHookFlagTablePath()
): void {
  const kept: { codexVersion: string; modifiedMs: number }[] = []
  for (const entry of listCodexHookFlagEntries(table)) {
    if (!keep(entry)) {
      removeCodexHookFlagEntry(entry.codexVersion, table)
      continue
    }
    try {
      const { mtimeMs } = lstatSync(
        join(table, `${entry.codexVersion}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`)
      )
      kept.push({ codexVersion: entry.codexVersion, modifiedMs: mtimeMs })
    } catch {
      // Why: removed meanwhile.
    }
  }
  kept.sort((a, b) => b.modifiedMs - a.modifiedMs)
  for (const { codexVersion } of kept.slice(cap)) {
    removeCodexHookFlagEntry(codexVersion, table)
  }
}

/**
 * A Git Bash pane's `command -v` path (`/c/Users/...`) as Windows spells it,
 * which Node can resolve; any other path unchanged.
 */
export function fromMsysPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const msys = platform === 'win32' ? /^\/([A-Za-z])(?:\/(.*))?$/.exec(path) : null
  return msys ? `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replaceAll('/', '\\')}` : path
}

/**
 * The binary a codex path's probes run: npm's PowerShell shim (codex.ps1)
 * cannot be spawned directly, so its sibling codex.cmd, which runs the same
 * install, stands in for it.
 */
export function resolveCodexProbePath(codexPath: string): string {
  if (!/^codex\.ps1$/i.test(basename(codexPath))) {
    return codexPath
  }
  const sibling = join(dirname(codexPath), 'codex.cmd')
  return existsSync(sibling) ? sibling : codexPath
}

/** Reads and deletes every pending request. Unusable names and anything but a file are skipped. */
export function takeCodexHookFlagRequests(
  table = getCodexHookFlagTablePath()
): CodexHookFlagRequest[] {
  const requests: CodexHookFlagRequest[] = []
  for (const codexVersion of listNames(table, CODEX_HOOK_FLAG_REQUEST_SUFFIX)) {
    const path = join(table, `${codexVersion}${CODEX_HOOK_FLAG_REQUEST_SUFFIX}`)
    if (!isPlainFile(path)) {
      continue
    }
    // Why trim: it also drops the byte-order mark PowerShell 5.1 writes.
    const codexPath = readFirstLine(path)?.trim() || null
    removeFile(path)
    if (isCodexHookFlagEntryName(codexVersion)) {
      requests.push({ codexVersion, codexPath })
    }
  }
  return requests
}
