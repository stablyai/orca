import { readClaudeTranscriptLeafWithReproof } from './claude-transcript-branch-proof'
import type {
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

/** Wait for each first-hand exit's publication, including exits observed while waiting. */
export async function drainClaudeObservedExits(
  exits: Map<string, ClaudeSessionExit>
): Promise<void> {
  const awaited = new Set<Promise<void>>()
  for (;;) {
    const pending = [...exits.values()]
      .map((exit) => exit.publication)
      .filter(
        (publication): publication is Promise<void> =>
          publication !== undefined && !awaited.has(publication)
      )
    if (pending.length === 0) {
      return
    }
    for (const publication of pending) {
      awaited.add(publication)
    }
    await Promise.all(pending)
  }
}

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
    // An unavailable tail must not overwrite the last observed leaf.
  }
  await deps.persistHandle?.({
    sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid: session.leafUuid,
    fence: session.fence
  })
}
