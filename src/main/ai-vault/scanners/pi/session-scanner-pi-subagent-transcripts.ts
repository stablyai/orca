import { basename, dirname, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  wslGatedReaddir,
  wslGatedStat
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'

// pi-subagents writes every child under the parent transcript's stem directory, one run level deep.
const PI_SUBAGENT_MAX_DEPTH = 3

export function piSubagentSessionsDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem)
}

/** Fresh runs write `session.jsonl`; forked children branch into their own `<stem>.jsonl`. */
function isPiSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  return isFile && extname(name).toLowerCase() === '.jsonl'
}

/** A directory the walk read, with the mtime it had; `null` records one that did not exist. */
export type PiSubagentDirStamp = { path: string; mtimeMs: number | null }

export type PiSubagentTranscriptWalk = {
  /** Children found before any failed read; they are real even when the walk is incomplete. */
  paths: string[]
  /** Every directory whose entries were read; null when the walk cannot vouch for its own reads. */
  dirs: PiSubagentDirStamp[] | null
  /** The first read that failed for a reason other than absence, so the count stays unknown. */
  failure: { path: string; error: unknown } | null
}

function forgetDirStamps(walk: PiSubagentTranscriptWalk, path: string, error: unknown): void {
  walk.dirs = null
  walk.failure ??= { path, error }
}

/** Null when the directory cannot be stamped: its entries still count, they just cannot vouch for reuse. */
async function stampSubagentDir(
  path: string,
  walk: PiSubagentTranscriptWalk,
  signal?: AbortSignal
): Promise<PiSubagentDirStamp | null> {
  try {
    const stats = await waitForAiVaultScan(wslGatedStat(path, 'scan', signal), signal)
    return { path, mtimeMs: stats.mtimeMs }
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    if (!isMissingTranscriptPathError(err)) {
      walk.dirs = null
      return null
    }
    return { path, mtimeMs: null }
  }
}

/** A missing directory is absence; any other read failure is recorded and the walk continues. */
async function collectSubagentTranscripts(
  path: string,
  depth: number,
  walk: PiSubagentTranscriptWalk,
  signal?: AbortSignal
): Promise<void> {
  // Stamp before reading: an entry created in between must force the next walk, not hide behind it.
  const stamp = await stampSubagentDir(path, walk, signal)
  let entries: Dirent[]
  try {
    entries = await waitForAiVaultScan(wslGatedReaddir(path, 'scan', signal), signal)
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    if (!isMissingTranscriptPathError(err)) {
      forgetDirStamps(walk, path, err)
      return
    }
    // Absence at read time overrides a stamp just taken: a rename keeps the mtime, so the old one would lie.
    walk.dirs?.push({ path, mtimeMs: null })
    return
  }
  if (stamp !== null) {
    walk.dirs?.push(stamp)
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      if (depth < PI_SUBAGENT_MAX_DEPTH) {
        await collectSubagentTranscripts(entryPath, depth + 1, walk, signal)
      }
      continue
    }
    if (isPiSubagentTranscriptFileName(entry.name, entry.isFile())) {
      walk.paths.push(entryPath)
    }
  }
}

export async function findPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<PiSubagentTranscriptWalk> {
  const walk: PiSubagentTranscriptWalk = { paths: [], dirs: [], failure: null }
  await collectSubagentTranscripts(piSubagentSessionsDirFor(transcriptFilePath), 1, walk, signal)
  return walk
}

/** Null keeps the stored count: a failed read proves nothing about a parent that may have children. */
export async function countPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<number | null> {
  const walk = await findPiSubagentTranscripts(transcriptFilePath, signal)
  return walk.failure === null ? walk.paths.length : null
}

/**
 * True only when every visited directory still shows its stamped mtime, so a cached count
 * survives without another walk. An unstamped directory or a failed stat proves nothing.
 */
export async function piSubagentDirsUnchanged(
  dirs: readonly PiSubagentDirStamp[],
  signal?: AbortSignal
): Promise<boolean> {
  if (dirs.length === 0) {
    return false
  }
  for (const dir of dirs) {
    let mtimeMs: number | null
    try {
      const stats = await waitForAiVaultScan(wslGatedStat(dir.path, 'scan', signal), signal)
      mtimeMs = stats.mtimeMs
    } catch (err) {
      throwIfAiVaultScanCancelled(signal)
      if (!isMissingTranscriptPathError(err)) {
        return false
      }
      mtimeMs = null
    }
    if (mtimeMs !== dir.mtimeMs) {
      return false
    }
  }
  return true
}
