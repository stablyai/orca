import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredChatNamingDeps } from './structured-chat-naming-types'

type NamingStore = NonNullable<ReturnType<StructuredChatNamingDeps['getStore']>>

/** Person-asked naming. A typed title stays until a generated name is ready to replace it. */
export function startStructuredChatNameRegenerate(args: {
  record: AgentSessionRecord
  run: (record: AgentSessionRecord, automatic: boolean) => void
}): boolean {
  args.run(args.record, false)
  return true
}

/** Drop a typed title only after a name exists. Put it back when the compare-and-set misses. */
export async function writeGeneratedConversationName(args: {
  store: NamingStore
  record: AgentSessionRecord
  name: string
  contextId: string | null
}): Promise<AgentSessionRecord | null> {
  const { store, record, name, contextId } = args
  let expected = record.conversationName ?? null
  const typed = record.conversationNameSource === 'user' ? record.conversationName : undefined
  if (typed) {
    const { applied } = await store.setUserConversationName(record.sessionId, typed, 'release')
    if (!applied) {
      return null
    }
    expected = null
  }
  const restore = async () => {
    if (!typed) {
      return
    }
    const current = store.getRecord(record.sessionId)
    if (
      current &&
      current.conversationName === undefined &&
      current.conversationNameSource !== 'user'
    ) {
      await store.setUserConversationName(record.sessionId, typed, 'rename')
    }
  }
  try {
    const named = await store.compareAndSetConversationName(
      record.sessionId,
      name,
      expected,
      contextId
    )
    if (!named) {
      await restore()
    }
    return named
  } catch (error) {
    // A failed restore still reports the compare-and-set error. The slot stays empty only if both fail.
    await restore().catch(() => undefined)
    throw error
  }
}
