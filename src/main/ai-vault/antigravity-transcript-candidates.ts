import { dirname, join } from 'node:path'
import { wslGatedLstat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'

function transcriptDirectory(file: FileWithMtime): string {
  return file.path
    .split(/[\\/]+/)
    .slice(0, -1)
    .join('/')
}

/** Keep the file's own stat intact; alias recency only drives discovery/cutoff. */
export function prioritizeAntigravityTranscriptCandidates<T extends { file: FileWithMtime }>(
  candidates: T[],
  isAntigravity: (candidate: T) => boolean
): T[] {
  const newest = new Map<string, number>()
  for (const candidate of candidates) {
    if (isAntigravity(candidate)) {
      const key = transcriptDirectory(candidate.file)
      newest.set(key, Math.max(newest.get(key) ?? 0, candidate.file.mtimeMs))
    }
  }
  return candidates
    .map((candidate) =>
      isAntigravity(candidate)
        ? {
            ...candidate,
            file: {
              ...candidate.file,
              aliasMtimeMs: newest.get(transcriptDirectory(candidate.file))
            }
          }
        : candidate
    )
    .sort((left, right) => {
      const difference = (candidateFileTime(right.file) ?? 0) - (candidateFileTime(left.file) ?? 0)
      if (difference !== 0) {
        return difference
      }
      if (
        isAntigravity(left) &&
        isAntigravity(right) &&
        transcriptDirectory(left.file) === transcriptDirectory(right.file)
      ) {
        return (
          Number(right.file.path.endsWith('transcript_full.jsonl')) -
          Number(left.file.path.endsWith('transcript_full.jsonl'))
        )
      }
      return 0
    })
}

export function candidateFileTime(file: FileWithMtime | undefined): number | undefined {
  return file?.aliasMtimeMs ?? file?.mtimeMs
}

/** The recency cap may retain a newer compact file but omit its older full sibling. */
export async function completeAntigravityTranscriptPairs(
  discovery: SessionFileDiscovery,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const files = new Map(discovery.files.map((file) => [file.path, file]))
  for (const file of discovery.files) {
    const sibling = join(
      dirname(file.path),
      file.path.endsWith('transcript_full.jsonl') ? 'transcript.jsonl' : 'transcript_full.jsonl'
    )
    if (files.has(sibling)) {
      continue
    }
    try {
      const observed = await wslGatedLstat(sibling, 'scan')
      if (observed.isFile()) {
        files.set(sibling, {
          path: sibling,
          mtimeMs: observed.mtimeMs,
          modifiedAt: new Date(observed.mtimeMs).toISOString(),
          sizeBytes: observed.size,
          dev: observed.dev,
          ino: observed.ino,
          nlink: observed.nlink
        })
      }
    } catch (error) {
      if (error instanceof WslTranscriptFsError) {
        recordSessionScanIssue(issues, {
          agent: 'antigravity',
          path: sibling,
          message: error.message
        })
      }
    }
  }
  return { ...discovery, files: [...files.values()] }
}
