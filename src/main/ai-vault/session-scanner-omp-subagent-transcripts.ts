import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname, extname, join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { SubagentTranscriptPartition } from './session-scanner-subagent-transcripts'
import type { ResumableSessionParseState } from './session-scanner-types'

// Infer lineage from stamp_UUID artifact directories: task transcripts are label-named and omit parentSession (#9330).
const OMP_SESSION_DIR_NAME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

export const OMP_SESSION_ARTIFACT_DIR_PATTERN = new RegExp(`^${OMP_SESSION_DIR_NAME}$`, 'i')

// Remote counts include only direct artifact children, matching local readdir; nested grandchildren remain excluded.
const OMP_SUBAGENT_SUBTREE_PATTERN = new RegExp(String.raw`[\\/]${OMP_SESSION_DIR_NAME}[\\/]`, 'i')
const OMP_SUBAGENT_DIRECT_CHILD_PATTERN = new RegExp(
  String.raw`^(.*[\\/]${OMP_SESSION_DIR_NAME})[\\/][^\\/]+\.jsonl$`,
  'i'
)

export function ompArtifactDirFor(transcriptFilePath: string): string {
  const stem = basename(transcriptFilePath, extname(transcriptFilePath))
  return join(dirname(transcriptFilePath), stem)
}

export function isOmpSubagentTranscriptFileName(name: string, isFile: boolean): boolean {
  return isFile && extname(name).toLowerCase() === '.jsonl'
}

/** Count direct task transcripts only; nested artifacts and grandchildren belong to their own parents. */
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

/** Partition the remote walk to count task transcripts without extra SSH directory reads. */
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

/** Count on the transcript-owning host only; remote walks supply their own counts. */
export function withOmpSubagentTranscriptCount(
  state: ResumableSessionParseState,
  transcriptFilePath: string
): ResumableSessionParseState {
  return {
    consumeLine: (line) => state.consumeLine(line),
    identity: () => state.identity?.() ?? null,
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
