import { expect, it, vi } from 'vitest'
import {
  createStructuredChatNamingHandler,
  type StructuredChatNamingDeps
} from './structured-chat-naming'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import {
  compareAndSetAgentSessionRecordName,
  setAgentSessionRecordUserName
} from '../runtime/agent-session/records/agent-session-record-conversation-name'

function rig(
  generate: StructuredChatNamingDeps['generate'],
  captureAutomaticTitle: StructuredChatNamingDeps['captureAutomaticTitle'] = () => ({ owner: null })
) {
  let record = agentSessionRecordFixture({ sessionId: 'chat-1' })
  let beforeWrite: (() => Promise<void>) | undefined
  const handler = createStructuredChatNamingHandler({
    getStore: () => ({
      getRecord: () => record,
      compareAndSetConversationName: async (_id, name, expected, context, applicable) =>
        compareAndSetAgentSessionRecordName(
          async (apply) => {
            if (expected !== null) {
              await beforeWrite?.()
            }
            record = apply(record)
            return record
          },
          name,
          expected,
          context,
          applicable
        ),
      setUserConversationName: async (_id, name, write) => {
        const result = setAgentSessionRecordUserName(record, name, write, 1)
        record = result.record
        return result
      }
    }),
    getSettings: () => ({ nativeChatAutoName: true }),
    readFirstPrompt: async () => 'Repair login',
    readJournalFirstPrompt: async () => 'Repair login',
    workerTaskTitle: () => null,
    generate,
    captureAutomaticTitle,
    wait: async () => {},
    onNamed: () => {},
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  return {
    handler,
    record: () => record,
    beforeWrite: (run: () => Promise<void>) => {
      beforeWrite = run
    },
    start: () =>
      handler(
        {
          sessionId: 'chat-1',
          workspaceId: 'workspace-1',
          agent: 'claude',
          status: 'working',
          latestPrompt: 'Repair login',
          updatedAt: 1
        },
        { replay: false, firstInputSubmissionKey: 'input-1' }
      ),
    done: () => vi.waitFor(() => expect(handler.activeSessionIds()).toEqual([]))
  }
}

it.each(['owner', 'same-text rename'] as const)(
  'rejects a queued title write after %s changes',
  async (change) => {
    let owned = true
    const state = rig(
      async (_record, _prompt, _current, automatic) =>
        automatic ? { name: 'CLI title', shouldApply: () => owned } : { name: 'Independent title' },
      () => ({
        owner: { isCurrent: () => owned, generate: async () => null }
      })
    )
    state.beforeWrite(async () => {
      if (change === 'owner') {
        owned = false
      } else {
        await state.handler.setUserName('chat-1', 'Repair login', 'rename')
      }
    })
    state.start()
    await state.done()
    expect(state.record().conversationName).toBe(
      change === 'owner' ? 'Independent title' : 'Repair login'
    )
  }
)
