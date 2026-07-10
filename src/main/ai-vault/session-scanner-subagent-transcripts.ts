import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

// Claude writes subagent transcripts to a sibling directory named after the
// parent transcript file (…/<enc>/<uuid>.jsonl → …/<enc>/<uuid>/subagents/).
// These survive intact even when the parent conversation persisted zero turns,
// so they are the recoverable signal that keeps such a session from being hidden.
export function subagentTranscriptsDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem, 'subagents')
}

/**
 * Count sibling subagent transcript files for a session's transcript. Returns 0
 * when the directory is absent (the common case), so callers can treat any
 * positive count as recoverable content. Meta sidecars (`*.meta.json`) are not
 * transcripts and are excluded.
 */
export async function countSubagentTranscripts(transcriptFilePath: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(subagentTranscriptsDirFor(transcriptFilePath))
  } catch {
    return 0
  }
  return entries.filter((name) => name.endsWith('.jsonl')).length
}

// Direct child of a subagents dir: `<parent>/<uuid>/subagents/<file>.jsonl`.
// Greedy prefix means nested subagent trees attribute to their nearest parent,
// matching the local direct-children-only readdir semantics.
const SUBAGENT_DIRECT_CHILD_PATTERN = /^(.*)[\\/]subagents[\\/][^\\/]+\.jsonl$/i
const SUBAGENT_SUBTREE_PATTERN = /[\\/]subagents[\\/]/i

/**
 * Partition a recursively walked transcript listing into session candidates and
 * per-parent sibling subagent transcript counts. Remote (SSH) scans cannot
 * readdir the transcript's sibling directory, but their walk already enumerates
 * subagent paths — counting from the listing costs no extra round-trips.
 * Subagent transcripts share the parent sessionId and are not independently
 * resumable, so they are excluded from candidates (mirrors the local discovery
 * pruning in session-scanner-source-discovery.ts).
 */
export function partitionSubagentTranscriptPaths(paths: readonly string[]): {
  sessionFilePaths: string[]
  subagentTranscriptCounts: Map<string, number>
} {
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
