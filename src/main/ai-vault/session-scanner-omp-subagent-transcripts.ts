import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname, extname, join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { SubagentTranscriptPartition } from './session-scanner-subagent-transcripts'
import type { ResumableSessionParseState } from './session-scanner-types'

// OMP names every session `<ISO-stamp>_<uuidv7>` and stores that session's
// artifacts — including its task-subagent transcripts — in a sibling directory
// of the same name (…/<workspace>/<stamp>_<uuid>.jsonl + …/<stamp>_<uuid>/).
// The anchored name pattern is the classification signal: task-child
// transcripts are label-named, so they can't match. Workspace dirs are encoded
// from a cwd and can't realistically match either, but the local prune doesn't
// rely on that — it skips depth 0 outright. This deliberately reads structure
// rather than a transcript's own records: children carry their own session id
// and no parentSession field at all, so lineage is not available here (#9330).
const OMP_SESSION_DIR_NAME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

// Exported so discovery prunes exactly the subtrees this module reads on
// demand — the pruning predicate and the lister can't drift apart.
export const OMP_SESSION_ARTIFACT_DIR_PATTERN = new RegExp(`^${OMP_SESSION_DIR_NAME}$`, 'i')

// Direct child of a session artifact dir: `…/<stamp>_<uuid>/<label>.jsonl`.
// A child's own artifact dir is label-named (`<stamp>_<uuid>/<label>/`), so a
// grandchild is one segment too deep for this pattern and counts toward
// nobody — matching the local direct-children-only readdir. The greedy prefix
// only matters for a stamped dir nested under another, which OMP never emits.
const OMP_SUBAGENT_SUBTREE_PATTERN = new RegExp(String.raw`[\\/]${OMP_SESSION_DIR_NAME}[\\/]`, 'i')
const OMP_SUBAGENT_DIRECT_CHILD_PATTERN = new RegExp(
  String.raw`^(.*[\\/]${OMP_SESSION_DIR_NAME})[\\/][^\\/]+\.jsonl$`,
  'i'
)

export function ompArtifactDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem)
}

// The count below and the on-demand lister both key off this one predicate so
// the "N subagents" badge can never disagree with the expanded list.
export function isOmpSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  return isFile && extname(name).toLowerCase() === '.jsonl'
}

/**
 * Count the task-subagent transcripts stored in a session's artifact directory.
 * Returns 0 when the directory is absent (the common case for sessions that
 * never delegated). Only direct children count: nested dirs (`local/`, a
 * child's own artifact dir) hold artifacts and grandchild transcripts, which
 * belong to their own parents.
 */
export async function countOmpSubagentTranscripts(transcriptFilePath: string): Promise<number> {
  let entries
  try {
    entries = await wslGatedReaddir(ompArtifactDirFor(transcriptFilePath), 'scan')
  } catch {
    return 0
  }
  return entries.filter((entry) => isOmpSubagentTranscriptFileName(entry.name, entry.isFile()))
    .length
}

/**
 * Partition a recursively walked OMP transcript listing into session
 * candidates and per-parent subagent transcript counts. Remote (SSH) scans
 * cannot readdir a transcript's sibling directory, but their walk already
 * enumerates subagent paths — counting from the listing costs no extra
 * round-trips (mirrors the Claude partition in
 * session-scanner-subagent-transcripts.ts).
 */
export function partitionOmpSubagentTranscriptPaths(
  paths: readonly string[]
): SubagentTranscriptPartition {
  const sessionFilePaths: string[] = []
  const subagentTranscriptCounts = new Map<string, number>()
  for (const path of paths) {
    if (!OMP_SUBAGENT_SUBTREE_PATTERN.test(path)) {
      sessionFilePaths.push(path)
      continue
    }
    const directChild = OMP_SUBAGENT_DIRECT_CHILD_PATTERN.exec(path)
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

/**
 * Attach the sibling artifact-dir transcript count to an OMP session parse.
 * The artifact dir lives on the host that owns the transcript, so content
 * fetched from a remote (SSH) host must not readdir this machine's disk — the
 * remote walk's partition supplies those counts instead.
 */
export function withOmpSubagentTranscriptCount(
  state: ResumableSessionParseState,
  transcriptFilePath: string
): ResumableSessionParseState {
  return {
    consumeLine: (line) => state.consumeLine(line),
    clone: () => withOmpSubagentTranscriptCount(state.clone(), transcriptFilePath),
    touchFile: (file) => state.touchFile(file),
    finalize: async (platform, options) => {
      const session = await state.finalize(platform, options)
      const ownsTranscriptDisk =
        !options?.executionHostId || options.executionHostId === LOCAL_EXECUTION_HOST_ID
      if (!session || !ownsTranscriptDisk) {
        return session
      }
      return {
        ...session,
        subagentTranscriptCount: await countOmpSubagentTranscripts(transcriptFilePath)
      }
    }
  }
}
