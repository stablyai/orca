import type { StructuredAgentSessionHost } from './structured-agent-session-host'

type AccountSwitchHost = Pick<
  StructuredAgentSessionHost,
  'loadedSessionIds' | 'sessionAgent' | 'childAccountHome' | 'releaseOffAccount'
>

/** A running agent keeps the account it launched with, so after an account switch each idle chat of
 *  `agent` whose agent runs on another account than the committed selection stops; its next turn
 *  resumes the conversation on the selected account. Each check runs under the chat's own
 *  serialization against its current agent and selection, so a chat mid-turn or owed work (a lead's
 *  wake-up for a finished background task included) keeps its agent. */
export async function releaseIdleChatsOnOtherAccount(
  host: AccountSwitchHost | null,
  agent: string,
  /** False once the selection this switch saved is pending again or replaced: its later run decides. */
  committed: () => boolean
): Promise<void> {
  if (!host) {
    return
  }
  await Promise.all(
    host.loadedSessionIds().map(async (id) => {
      if (host.sessionAgent(id) !== agent || !host.childAccountHome(id)) {
        return
      }
      await host.releaseOffAccount(id, committed).catch((error: unknown) => {
        console.warn('[structured-agent-session] an idle chat kept the previous account:', error)
      })
    })
  )
}
