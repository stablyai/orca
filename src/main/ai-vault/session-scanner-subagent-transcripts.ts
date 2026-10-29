import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname, extname, join } from 'node:path'

export const SUBAGENT_DIR_NAME = 'subagents'

// Discovery, badge counts, and on-demand listing must agree on eligible transcripts.
export const SUBAGENT_TRANSCRIPT_PREFIX = 'agent-'

export function isSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  return (
    isFile &&
    name.startsWith(SUBAGENT_TRANSCRIPT_PREFIX) &&
    extname(name).toLowerCase() === '.jsonl'
  )
}

// Sibling subagents can preserve recoverable content even when the parent has no turns.
export function subagentTranscriptsDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem, SUBAGENT_DIR_NAME)
}

export async function countSubagentTranscripts(transcriptFilePath: string): Promise<number> {
  let entries
  try {
    entries = await wslGatedReaddir(subagentTranscriptsDirFor(transcriptFilePath), 'scan')
  } catch {
    return 0
  }
  return entries.filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile())).length
}

export type SubagentTranscriptPartition = {
  sessionFilePaths: string[]
  subagentTranscriptCounts: Map<string, number>
}
