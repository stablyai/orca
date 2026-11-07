import { dirname } from 'node:path'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { wslGatedReaddir } from '../../../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from '../../ai-vault-scan-cancellation'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'

const ARTIFACT_CHECK_CONCURRENCY = 8

/** `<brain>/<id>/` for a transcript under `<id>/.system_generated/logs/`. */
function antigravityConversationDir(transcriptPath: string): string | null {
  return antigravityConversationIdFromTranscriptPath(transcriptPath)
    ? dirname(dirname(dirname(transcriptPath)))
    : null
}

// Names only: artifacts are top-level files; agy's own state (.system_generated, scratch, .user_uploaded) is in subdirectories.
async function hasTopLevelArtifactFiles(dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const entries = await wslGatedReaddir(dir, 'scan', signal)
    return entries.some((entry) => entry.isFile() && !entry.name.startsWith('.'))
  } catch {
    // A missing or gated folder only hides the action; it is not a scan issue.
    throwIfAiVaultScanCancelled(signal)
    return false
  }
}

/** One directory listing per listed Antigravity row, so the menu never probes the disk itself. */
export async function withAntigravityArtifactsDirs(
  sessions: AiVaultSession[],
  signal?: AbortSignal
): Promise<AiVaultSession[]> {
  return mapWithConcurrency(sessions, ARTIFACT_CHECK_CONCURRENCY, async (session) => {
    const dir =
      session.agent === 'antigravity' ? antigravityConversationDir(session.filePath) : null
    if (!dir || !(await hasTopLevelArtifactFiles(dir, signal))) {
      return session
    }
    return { ...session, antigravityArtifactsDir: dir }
  })
}
