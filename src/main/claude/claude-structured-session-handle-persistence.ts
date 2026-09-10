import { readClaudeTranscriptLeafWithReproof } from './claude-transcript-branch-proof'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

/**
 * Writes the durable handle an exited session leaves behind.
 *
 * The transcript-derived cursor is refreshed first so a reacquisition resumes from the branch the
 * child actually wrote; a stale or unavailable tail keeps the last observed leaf rather than
 * overwriting it with a guess.
 */
export async function persistClaudeSessionHandle(
  sessionId: string,
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'readTranscriptLeaf' | 'persistHandle'>
): Promise<void> {
  try {
    const transcriptLeaf = deps.readTranscriptLeaf
      ? await readClaudeTranscriptLeafWithReproof({
          readTranscriptLeaf: deps.readTranscriptLeaf,
          providerSessionId: session.providerSessionId,
          previousLeafUuid: session.leafUuid,
          claudeConfigDir: session.claudeConfigDir
        })
      : null
    if (transcriptLeaf) {
      session.leafUuid = transcriptLeaf
    }
  } catch {
    // A stale or unavailable tail must not overwrite the last observed leaf.
  }
  await deps.persistHandle?.({
    sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid: session.leafUuid,
    fence: session.fence
  })
}
