import { createStructuredAgentSessionForWorktree } from './structured-sessions/creation/structured-agent-session-create'

/** Background work: a chat with no tab, which opening it later (`agentSession.reveal`) adds. */
export async function createBackgroundStructuredAgentSession(
  args: Omit<Parameters<typeof createStructuredAgentSessionForWorktree>[0], 'publishTab'>
): ReturnType<typeof createStructuredAgentSessionForWorktree> {
  const created = await createStructuredAgentSessionForWorktree({ ...args, publishTab: false })
  // Founding records every new chat as having a tab; this one has none for a restart to restore, yet
  // stays open, so orchestration mail still reaches it.
  if (created.ok) {
    await (
      await args.ensureHost()
    ).setSessionTabVisibility(args.envelope.sessionId, false, undefined, {
      background: true
    })
  }
  return created
}
