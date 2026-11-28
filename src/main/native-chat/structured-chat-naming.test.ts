import { describe, expect, it, vi } from 'vitest'
import {
  setAgentSessionRecordConversationName,
  setAgentSessionRecordUserName
} from '../runtime/agent-session/records/agent-session-record-conversation-name'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from './testing/agent-session-record-test-fixture'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'

const JOURNAL = '1. Fix login\n2. Add retry on 429'

function namedRecord(): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: 's1',
    conversationName: 'My title',
    conversationNameSource: 'user'
  })
}

function harness(args: {
  record?: AgentSessionRecord
  nativeChatAutoName?: boolean
  readJournalFirstPrompt?: () => Promise<string>
  readFirstPrompt?: () => Promise<string>
  generate?: (prompt: string) => Promise<{ name: string } | null>
  compareAndSet?: (
    record: AgentSessionRecord,
    name: string | null,
    expected: string | null
  ) => AgentSessionRecord | null
}) {
  let record = args.record ?? namedRecord()
  const writes: ('rename' | 'legacy-alias' | 'release')[] = []
  const prompts: string[] = []
  const store = {
    getRecord: () => record,
    setUserConversationName: async (
      _id: string,
      name: string,
      write: 'rename' | 'legacy-alias' | 'release'
    ) => {
      writes.push(write)
      const result = setAgentSessionRecordUserName(record, name, write, 1)
      record = result.record
      return result
    },
    compareAndSetConversationName: async (
      _id: string,
      name: string | null,
      expected: string | null
    ) => {
      if (args.compareAndSet) {
        const next = args.compareAndSet(record, name, expected)
        if (next) {
          record = next
        }
        return next
      }
      if (
        record.conversationNameSource === 'user' ||
        (record.conversationName ?? null) !== expected
      ) {
        return null
      }
      record = setAgentSessionRecordConversationName(record, name, 2)
      return record
    }
  }
  const handler = createStructuredChatNamingHandler({
    getStore: () => store,
    getSettings: () => ({ nativeChatAutoName: args.nativeChatAutoName ?? false }),
    readFirstPrompt: args.readFirstPrompt ?? (async () => 'first only'),
    readJournalFirstPrompt: args.readJournalFirstPrompt ?? (async () => JOURNAL),
    workerTaskTitle: () => null,
    generate: async (_record, firstPrompt) => {
      prompts.push(firstPrompt)
      return args.generate ? args.generate(firstPrompt) : { name: 'Login retry on 429' }
    },
    onNamed: () => {},
    logger: { warn: () => {}, error: () => {} },
    wait: async () => {}
  })
  return {
    handler,
    writes,
    prompts,
    current: () => record
  }
}

describe('createStructuredChatNamingHandler regenerate', () => {
  it('releases a typed title only after a generated name is ready', async () => {
    const run = harness({})
    expect(run.handler.regenerate('s1')).toBe(true)
    await vi.waitFor(() => {
      expect(run.current().conversationName).toBe('Login retry on 429')
    })
    expect(run.current().conversationNameSource).toBeUndefined()
    expect(run.writes).toEqual(['release'])
  })

  it('keeps a typed title when naming returns nothing', async () => {
    const run = harness({ generate: async () => null })
    expect(run.handler.regenerate('s1')).toBe(true)
    await vi.waitFor(() => {
      expect(run.prompts).toEqual([JOURNAL])
    })
    expect(run.current().conversationName).toBe('My title')
    expect(run.current().conversationNameSource).toBe('user')
    expect(run.writes).toEqual([])
  })

  it('keeps a typed title when the journal has no prompt', async () => {
    let read = false
    const run = harness({
      readJournalFirstPrompt: async () => {
        read = true
        return ''
      }
    })
    expect(run.handler.regenerate('s1')).toBe(true)
    await vi.waitFor(() => {
      expect(read).toBe(true)
    })
    expect(run.prompts).toEqual([])
    expect(run.current().conversationName).toBe('My title')
    expect(run.current().conversationNameSource).toBe('user')
    expect(run.writes).toEqual([])
  })

  it('restores a typed title when compare-and-set misses', async () => {
    const run = harness({ compareAndSet: () => null })
    expect(run.handler.regenerate('s1')).toBe(true)
    await vi.waitFor(() => {
      expect(run.writes).toEqual(['release', 'rename'])
    })
    expect(run.current().conversationName).toBe('My title')
    expect(run.current().conversationNameSource).toBe('user')
  })

  it('keeps the journal rename when automatic naming starts during prepare', async () => {
    let releaseJournal: (prompt: string) => void = () => {}
    const journal = new Promise<string>((resolve) => {
      releaseJournal = resolve
    })
    let preparing: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      preparing = resolve
    })
    const run = harness({
      nativeChatAutoName: true,
      readJournalFirstPrompt: () => {
        preparing()
        return journal
      },
      generate: async (prompt) => ({
        name: prompt.includes('Add retry') ? 'Login retry on 429' : 'From first'
      })
    })
    expect(run.handler.regenerate('s1')).toBe(true)
    await started
    const summary: AgentSessionStatusSummary = {
      sessionId: 's1',
      workspaceId: 'workspace-1',
      agent: 'claude',
      status: 'working',
      latestPrompt: 'first only',
      updatedAt: 0
    }
    run.handler(summary, { replay: false, firstInputSubmissionKey: 'submit-1' })
    releaseJournal(JOURNAL)
    await vi.waitFor(() => {
      expect(run.current().conversationName).toBe('Login retry on 429')
    })
    expect(run.prompts).toEqual([JOURNAL])
  })

  it('puts a typed title back when compare-and-set throws', async () => {
    const run = harness({
      compareAndSet: () => {
        throw new Error('journal write failed')
      }
    })
    expect(run.handler.regenerate('s1')).toBe(true)
    await vi.waitFor(() => {
      expect(run.writes).toEqual(['release', 'rename'])
    })
    expect(run.current().conversationName).toBe('My title')
    expect(run.current().conversationNameSource).toBe('user')
  })

  it('still renames after an automatic run that was already writing', async () => {
    let releaseAuto: (value: { name: string }) => void = () => {}
    const autoName = new Promise<{ name: string }>((resolve) => {
      releaseAuto = resolve
    })
    let autoStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      autoStarted = resolve
    })
    const run = harness({
      record: agentSessionRecordFixture({ sessionId: 's1' }),
      nativeChatAutoName: true,
      readFirstPrompt: async () => 'first only',
      generate: async (prompt) => {
        if (prompt === 'first only') {
          autoStarted()
          return autoName
        }
        return { name: prompt.includes('Add retry') ? 'Login retry on 429' : 'From first' }
      }
    })
    const summary: AgentSessionStatusSummary = {
      sessionId: 's1',
      workspaceId: 'workspace-1',
      agent: 'claude',
      status: 'working',
      latestPrompt: 'first only',
      updatedAt: 0
    }
    run.handler(summary, { replay: false, firstInputSubmissionKey: 'submit-1' })
    await started
    expect(run.handler.regenerate('s1')).toBe(true)
    releaseAuto({ name: 'From first' })
    await vi.waitFor(() => {
      expect(run.current().conversationName).toBe('Login retry on 429')
    })
  })
})
