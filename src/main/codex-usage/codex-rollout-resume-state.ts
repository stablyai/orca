import type { CodexUsageParseContext } from './codex-usage-record-parser'
import type { CodexUsageParseResumeState, CodexUsagePersistedFile } from './types'
import {
  buildJsonlFileCheckpoint,
  resolveJsonlFileCheckpoint,
  type JsonlFileReader
} from '../usage/jsonl-file-checkpoint'

export { MIN_RESUMABLE_PREFIX_BYTES, isResumablePrefixLength } from '../usage/jsonl-file-checkpoint'

export async function buildCodexRolloutResumeState(
  filePath: string,
  parsedBytes: number,
  context: CodexUsageParseContext,
  verifiedHeadDigest: string | null = null,
  reader?: JsonlFileReader
): Promise<CodexUsageParseResumeState | null> {
  const checkpoint = await buildJsonlFileCheckpoint(
    filePath,
    parsedBytes,
    verifiedHeadDigest,
    reader
  )
  return checkpoint === null
    ? null
    : {
        ...checkpoint,
        sessionId: context.sessionId,
        sessionCwd: context.sessionCwd,
        currentCwd: context.currentCwd,
        currentModel: context.currentModel,
        previousTotals: context.previousTotals
      }
}

export async function resolveCodexRolloutResume(
  filePath: string,
  previous: CodexUsagePersistedFile | undefined,
  reader?: JsonlFileReader
): Promise<CodexUsageParseResumeState | null> {
  const resume = previous?.parseResumeState
  if (!resume || typeof resume.sessionId !== 'string') {
    return null
  }
  return (await resolveJsonlFileCheckpoint(filePath, resume, reader)) === null ? null : resume
}
