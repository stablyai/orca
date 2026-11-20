import { basename, dirname, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import { wslGatedReaddir } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'

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

async function readSubagentDir(path: string, signal?: AbortSignal): Promise<Dirent[] | null> {
  try {
    return await waitForAiVaultScan(wslGatedReaddir(path, 'scan', signal), signal)
  } catch {
    throwIfAiVaultScanCancelled(signal)
    return null
  }
}

/** Bound the walk: a grandchild's own stem directory sits deeper and belongs to that child. */
async function collectSubagentTranscripts(
  path: string,
  depth: number,
  found: string[],
  signal?: AbortSignal
): Promise<void> {
  for (const entry of (await readSubagentDir(path, signal)) ?? []) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      if (depth < PI_SUBAGENT_MAX_DEPTH) {
        await collectSubagentTranscripts(entryPath, depth + 1, found, signal)
      }
      continue
    }
    if (isPiSubagentTranscriptFileName(entry.name, entry.isFile())) {
      found.push(entryPath)
    }
  }
}

export async function findPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<string[]> {
  const found: string[] = []
  await collectSubagentTranscripts(piSubagentSessionsDirFor(transcriptFilePath), 1, found, signal)
  return found
}

export async function countPiSubagentTranscripts(
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<number> {
  const found = await findPiSubagentTranscripts(transcriptFilePath, signal)
  return found.length
}
