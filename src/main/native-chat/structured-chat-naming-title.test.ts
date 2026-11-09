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

it('tries CLI reuse once while independent generation retries, and skips it on manual regeneration', async () => {
  const reuse = vi.fn()
  const generate = vi.fn<StructuredChatNamingDeps['generate']>(
    async (_record, _prompt, _current, automatic) => {
      if (automatic) {
        reuse()
      }
      return generate.mock.calls.length === 1
        ? { error: 'Retry independent generation' }
        : { name: 'Login repair' }
    }
  )
  const state = rig(generate)
  state.start()
  await state.done()
  expect(state.record().conversationName).toBe('Login repair')
  expect(reuse).toHaveBeenCalledOnce()
  state.handler.regenerate('chat-1')
  await state.done()
  expect(reuse).toHaveBeenCalledOnce()
})

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

it('uses current naming settings if they change while the title write is queued', async () => {
  let eligible = true
  const generate = vi.fn<StructuredChatNamingDeps['generate']>(
    async (_record, _prompt, _current, automatic) =>
      automatic ? { name: 'CLI title', shouldApply: () => eligible } : { name: 'Configured title' }
  )
  const state = rig(generate)
  state.beforeWrite(async () => {
    eligible = false
  })
  state.start()
  await state.done()
  expect(state.record().conversationName).toBe('Configured title')
})
