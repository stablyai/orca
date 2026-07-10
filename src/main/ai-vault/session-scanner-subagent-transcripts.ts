import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

// Exported so discovery can prune these subtrees using the same literal that
// locates them here — the pruning comment and behavior can't drift.
export const SUBAGENT_DIR_NAME = 'subagents'

// Claude names every Task subagent transcript `agent-<id>.jsonl`. The row-badge
// count, the recoverable-empty signal, and the on-demand lister all key off this
// one predicate so the "N subagents" badge can never disagree with the expanded
// list (a stray non-transcript `.jsonl` or a dir named `x.jsonl` would otherwise
// inflate the count).
export const SUBAGENT_TRANSCRIPT_PREFIX = 'agent-'

export function isSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  return (
    isFile &&
    name.startsWith(SUBAGENT_TRANSCRIPT_PREFIX) &&
    extname(name).toLowerCase() === '.jsonl'
  )
}

// Claude writes subagent transcripts to a sibling directory named after the
// parent transcript file (…/<enc>/<uuid>.jsonl → …/<enc>/<uuid>/subagents/).
// These survive intact even when the parent conversation persisted zero turns,
// so they are the recoverable signal that keeps such a session from being hidden.
export function subagentTranscriptsDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem, SUBAGENT_DIR_NAME)
}

/**
 * Count sibling subagent transcript files for a session's transcript. Returns 0
 * when the directory is absent (the common case), so callers can treat any
 * positive count as recoverable content. Meta sidecars (`*.meta.json`) are not
 * transcripts and are excluded.
 */
export async function countSubagentTranscripts(transcriptFilePath: string): Promise<number> {
  let entries
  try {
    entries = await readdir(subagentTranscriptsDirFor(transcriptFilePath), { withFileTypes: true })
  } catch {
    return 0
  }
  return entries.filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile())).length
}

// Direct child of a subagents dir: `<parent>/<uuid>/subagents/agent-<id>.jsonl`.
// The `agent-` prefix mirrors the local count/list predicate so remote badges
// can't over-count. Greedy prefix means nested subagent trees attribute to their
// nearest parent, matching the local direct-children-only readdir semantics.
const SUBAGENT_DIRECT_CHILD_PATTERN = /^(.*)[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/i
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
