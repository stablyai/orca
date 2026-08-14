import type { AiVaultSession } from '../../shared/ai-vault-types'
import { refreshCachedCodexTitle } from './session-scanner-codex-cached-title'
import { refreshCachedCursorCwd } from './session-scanner-cursor-project-cwd'
import { countOmpSubagentTranscripts } from './session-scanner-omp-subagent-transcripts'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import type { SessionFileCandidate } from './session-scanner-types'

export async function refreshCachedSessionSideChannels(
  candidate: SessionFileCandidate,
  session: AiVaultSession
): Promise<AiVaultSession> {
  // Why: a zero-turn transcript usually never changes again, but its sibling
  // subagent dir can gain files after the parent's last write.
  let next = session
  if (next.messageCount === 0) {
    const subagentTranscriptCount =
      candidate.agent === 'claude'
        ? await countSubagentTranscripts(candidate.file.path)
        : candidate.agent === 'omp'
          ? await countOmpSubagentTranscripts(candidate.file.path)
          : null
    if (
      subagentTranscriptCount !== null &&
      subagentTranscriptCount !== next.subagentTranscriptCount
    ) {
      next = { ...next, subagentTranscriptCount }
    }
  }
  if (candidate.agent === 'codex') {
    next = await refreshCachedCodexTitle(candidate, next)
  }
  if (candidate.agent === 'cursor') {
    next = refreshCachedCursorCwd(next)
  }
  return next
}
