import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createStructuredAgentSessionLogger } from './agent-session-wire/host/structured-agent-session-logger'

const CHATS = 100

async function burst() {
  // Each case starts from an empty generation-slot pool.
  vi.resetModules()
  const { createStructuredChatNamingHandler } = await import('./structured-chat-naming')
  const records = new Map<string, AgentSessionRecord>()
  for (let i = 0; i < CHATS; i++) {
    const sessionId = `session-${i}`
    records.set(sessionId, agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })))
  }
  const store = {
    getRecord: (sessionId: string) => records.get(sessionId) ?? null,
    compareAndSetConversationName: async (
      sessionId: string,
      name: string,
      expected: string | null
    ) => {
      const record = records.get(sessionId)
      if (!record || (record.conversationName ?? null) !== expected) {
        return null
      }
      const named = { ...record, conversationName: name }
      records.set(sessionId, named)
      return named
    },
    setUserConversationName: async () => {
      throw new Error('not used')
    }
  }
  const running: { sessionId: string; finish: () => void }[] = []
  const started: string[] = []
  let peak = 0
  const naming = createStructuredChatNamingHandler({
    getStore: () => store,
    getSettings: () => ({ nativeChatAutoName: true }),
    readFirstPrompt: async () => 'fix the flaky build',
    readJournalFirstPrompt: async () => 'fix the flaky build',
    workerTaskTitle: () => null,
    // As the production launcher does: every agent start goes through the admission.
    generate: async (record, _firstPrompt, _shouldExecute, admit) => {
      const task = await admit?.(() => {
        const result = new Promise<{ name: string }>((resolve) => {
          started.push(record.sessionId)
          running.push({
            sessionId: record.sessionId,
            finish: () => resolve({ name: `Named ${record.sessionId}` })
          })
          peak = Math.max(peak, running.length)
        })
        return { result, processClosed: result }
      })
      return task ? task.result : null
    },
    onNamed: () => {},
    logger: createStructuredAgentSessionLogger()
  })
  const settle = () => vi.advanceTimersByTimeAsync(0)
  const finishOne = async () => {
    running.shift()?.finish()
    await settle()
  }
  const startAll = async () => {
    for (const sessionId of records.keys()) {
      naming(
        {
          sessionId,
          workspaceId: 'workspace-1',
          agent: 'claude',
          status: 'working',
          latestPrompt: 'fix the flaky build',
          runtimePermission: null,
          updatedAt: 1
        },
        { replay: false, firstInputSubmissionKey: 'first' }
      )
    }
    await settle()
  }
  return { records, naming, running, started, peak: () => peak, startAll, finishOne }
}

// #45703: a launch burst started one naming agent CLI per new chat at once from main.
describe('chat naming during a launch burst', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at most three naming agents at a time and starts none for a chat named while queued', async () => {
    const { records, naming, running, started, peak, startAll, finishOne } = await burst()
    await startAll()
    expect(running).toHaveLength(3)

    // The user names a queued chat before its turn comes.
    const renamed = records.get('session-50')
    if (!renamed) {
      throw new Error('missing fixture record')
    }
    records.set('session-50', { ...renamed, conversationName: 'Mine' })
    // A user asking for a queued chat's name moves it ahead of automatic runs.
    expect(naming.regenerate('session-99')).toBe(true)

    while (running.length > 0) {
      await finishOne()
    }
    expect(peak()).toBe(3)
    expect(started[3]).toBe('session-99')
    expect(started).toHaveLength(CHATS - 1)
    expect(started).not.toContain('session-50')
  })

  it('lets the next chat start only once a naming agent outlives its own deadline', async () => {
    const { started, startAll } = await burst()
    await startAll()
    expect(started).toHaveLength(3)
    // The agent's 60 s deadline stops it; only one whose termination failed holds its slot longer.
    await vi.advanceTimersByTimeAsync(74_000)
    expect(started).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(started).toHaveLength(6)
  })
})
