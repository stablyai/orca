import { basename, dirname, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import { wslGatedReaddir } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
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

export type PiSubagentTranscriptWalk = {
  /** Children found before any failed read; they are real even when the walk is incomplete. */
  paths: string[]
  /** The first read that failed for a reason other than absence, so the count stays unknown. */
  failure: { path: string; error: unknown } | null
}

/** A missing directory is absence; any other read failure is recorded and the walk continues. */
async function collectSubagentTranscripts(
  path: string,
  depth: number,
  walk: PiSubagentTranscriptWalk,
  signal?: AbortSignal
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await waitForAiVaultScan(wslGatedReaddir(path, 'scan', signal), signal)
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    if (!isMissingTranscriptPathError(err) && walk.failure === null) {
      walk.failure = { path, error: err }
    }
    return
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
  const walk: PiSubagentTranscriptWalk = { paths: [], failure: null }
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
