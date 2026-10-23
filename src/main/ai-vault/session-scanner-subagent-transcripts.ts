import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
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
    entries = await wslGatedReaddir(subagentTranscriptsDirFor(transcriptFilePath), 'scan')
  } catch {
    return 0
  }
  return entries.filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile())).length
}

// One walked-listing partition: transcripts that are real session candidates,
// and per-parent counts for the subagent transcripts that were excluded.
export type SubagentTranscriptPartition = {
  sessionFilePaths: string[]
  subagentTranscriptCounts: Map<string, number>
}
