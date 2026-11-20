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

/** A missing directory is absence; any other read failure leaves the walk unsettled. */
async function readSubagentDir(path: string, signal?: AbortSignal): Promise<Dirent[] | null> {
  try {
    return await waitForAiVaultScan(wslGatedReaddir(path, 'scan', signal), signal)
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    return isMissingTranscriptPathError(err) ? [] : null
  }
}

/** False once a read fails: a partial walk must never pass for the parent's whole child set. */
async function collectSubagentTranscripts(
  path: string,
  depth: number,
  found: string[],
  signal?: AbortSignal
): Promise<boolean> {
  const entries = await readSubagentDir(path, signal)
  if (entries === null) {
    return false
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      if (
        depth < PI_SUBAGENT_MAX_DEPTH &&
        !(await collectSubagentTranscripts(entryPath, depth + 1, found, signal))
      ) {
        return false
      }
      continue
    }
    if (isPiSubagentTranscriptFileName(entry.name, entry.isFile())) {
      found.push(entryPath)
    }
  }
  return true
}

/** Null means an unreadable child directory, not a parent without children. */
export async function findPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const found: string[] = []
  const settled = await collectSubagentTranscripts(
    piSubagentSessionsDirFor(transcriptFilePath),
    1,
    found,
    signal
  )
  return settled ? found : null
}

/** Null keeps the stored count: a failed read proves nothing about a parent that may have children. */
export async function countPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<number | null> {
  const found = await findPiSubagentTranscripts(transcriptFilePath, signal)
  return found === null ? null : found.length
}
