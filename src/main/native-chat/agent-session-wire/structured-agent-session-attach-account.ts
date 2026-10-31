import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'

export function structuredAgentSessionAttachAccount(
  context: StructuredAgentSessionAttachContext,
  startedFor: string | undefined,
  lock: StructuredAgentSessionAttachLock
): NonNullable<AttachFlowInput['launchAccountRecipe']> {
  return async (record) => {
    const { account } = await lock.commit(async () => {
      const current = context.deps.store.requireWritableRecord(record.sessionId)
      const session = context.sessions.get(record.sessionId)
      const next = startedFor ? session?.journal.submission(startedFor) : undefined
      return {
        account: structuredAgentSessionReceivingAccount(
          context.deps,
          current,
          session,
          next,
          'identity'
        )
      }
    })
    return (await lock.wait(account)).recipe
  }
}
