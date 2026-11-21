import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  findPiSubagentTranscripts,
  piSubagentDirsUnchanged,
  type PiSubagentDirStamp
} from '../scanners/pi/session-scanner-pi-subagent-transcripts'

export type ReusedPiSubagentCount = {
  session: AiVaultSession
  /** The stamps the next reuse checks; undefined keeps it walking until a walk can stamp itself. */
  piSubagentDirs: PiSubagentDirStamp[] | undefined
}

/** Skip the walk while every visited directory keeps its stamped mtime; recount otherwise. */
export async function refreshReusedPiSubagentCount(
  transcriptFilePath: string,
  session: AiVaultSession,
  cachedDirs: readonly PiSubagentDirStamp[] | undefined,
  signal?: AbortSignal
): Promise<ReusedPiSubagentCount> {
  if (cachedDirs !== undefined && (await piSubagentDirsUnchanged(cachedDirs, signal))) {
    return { session, piSubagentDirs: [...cachedDirs] }
  }
  const walk = await findPiSubagentTranscripts(transcriptFilePath, signal)
  // A failed read proves nothing, so the stored count stands.
  const counted =
    walk.failure === null && walk.paths.length !== session.subagentTranscriptCount
      ? { ...session, subagentTranscriptCount: walk.paths.length }
      : session
  return { session: counted, piSubagentDirs: walk.dirs ?? undefined }
}
