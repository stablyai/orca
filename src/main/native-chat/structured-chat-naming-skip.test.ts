import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import type { StructuredChatNamingDeps } from './conversation-naming/structured-chat-naming-types'

const SKIP = { error: 'Choose a supported chat name agent', skipAutomatic: true } as const

let record: AgentSessionRecord
const generate = vi.fn<StructuredChatNamingDeps['generate']>()

function handler() {
  return createStructuredChatNamingHandler({
    getStore: () => ({
      getRecord: () => record,
      compareAndSetConversationName: async (_sessionId, name, expected) => {
        if ((record.conversationName ?? null) !== expected) {
          return null
        }
        record = { ...record, conversationName: name ?? undefined }
        return record
      },
      setUserConversationName: async () => ({ record, applied: false })
    }),
    getSettings: () => ({ nativeChatAutoName: true }),
    readFirstPrompt: async () => 'Fix the login bug',
    readJournalFirstPrompt: async () => 'Fix the login bug',
    workerTaskTitle: () => null,
    generate,
    onNamed: () => {},
    logger: { warn: () => {}, error: () => {} },
    wait: async () => {}
  })
}

const working = (): AgentSessionStatusSummary => ({
  sessionId: record.sessionId,
  workspaceId: record.location.workspaceId,
  agent: record.provider,
  status: 'working',
  latestPrompt: 'Fix the login bug',
  updatedAt: 0
})

async function settle(naming: ReturnType<typeof handler>) {
  await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
}

beforeEach(() => {
  record = agentSessionRecordFixture()
  generate.mockReset()
})

describe('chat naming when no agent can name the chat', () => {
  it('keeps the seed name on automatic naming, without a failure or retries', async () => {
    generate.mockResolvedValue(SKIP)
    const naming = handler()

    naming(working(), { replay: false, firstInputSubmissionKey: 'first' })
    await settle(naming)

    expect(generate).toHaveBeenCalledOnce()
    expect(record.conversationName).toBe('Fix the login bug')
    expect(naming.failure(record.sessionId)).toBeUndefined()
  })

  it('reports the reason when Regenerate joins automatic naming in progress', async () => {
    let resolveGenerate!: (result: typeof SKIP) => void
    generate.mockImplementation(() => new Promise((resolve) => (resolveGenerate = resolve)))
    const naming = handler()

    naming(working(), { replay: false, firstInputSubmissionKey: 'first' })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    naming.regenerate(record.sessionId)
    resolveGenerate(SKIP)
    await settle(naming)

    expect(generate).toHaveBeenCalledOnce()
    expect(naming.failure(record.sessionId)).toMatchObject({ message: SKIP.error })
  })

  it('reports the reason when the user asks to regenerate', async () => {
    generate.mockResolvedValue(SKIP)
    const naming = handler()

    naming.regenerate(record.sessionId)
    await settle(naming)

    expect(naming.failure(record.sessionId)).toMatchObject({ message: SKIP.error })
  })
})
