import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname, extname, join } from 'node:path'

export const SUBAGENT_DIR_NAME = 'subagents'

// Discovery, badge counts, and on-demand listing must agree on eligible transcripts.
export const SUBAGENT_TRANSCRIPT_PREFIX = 'agent-'

export function isSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  if (!isFile || name.toLowerCase().endsWith('.meta.json')) {
    return false
  }
  const ext = extname(name).toLowerCase()
  if (ext !== '.jsonl' && ext !== '.json') {
    return false
  }
  return (
    name.startsWith(SUBAGENT_TRANSCRIPT_PREFIX) ||
    name.startsWith('subagent-') ||
    name.startsWith('swarm-')
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

const SUBAGENT_DIRECT_CHILD_PATTERN =
  /^(.*)[\\/]subagents[\\/](?:agent-|subagent-|swarm-)[^\\/]+\.(?:jsonl|json)$/i
const SUBAGENT_SUBTREE_PATTERN = /[\\/]subagents[\\/]/i

export type SubagentTranscriptPartition = {
  sessionFilePaths: string[]
  subagentTranscriptCounts: Map<string, number>
}

export function partitionSubagentTranscriptPaths(
  paths: readonly string[]
): SubagentTranscriptPartition {
  const sessionFilePaths: string[] = []
  const subagentTranscriptCounts = new Map<string, number>()
  for (const path of paths) {
    if (!SUBAGENT_SUBTREE_PATTERN.test(path)) {
      sessionFilePaths.push(path)
      continue
    }
    const directChild = SUBAGENT_DIRECT_CHILD_PATTERN.exec(path)
    if (directChild) {
      const parentTranscriptPath = `${directChild[1]}.jsonl`
      subagentTranscriptCounts.set(
        parentTranscriptPath,
        (subagentTranscriptCounts.get(parentTranscriptPath) ?? 0) + 1
      )
    }
  }
  return { sessionFilePaths, subagentTranscriptCounts }
}
