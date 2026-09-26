import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { settleStaleSessionStateOnAcquire } from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { bindClaudeContextUsageCapture } from './claude-context-usage'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-context-restart-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function frame(message: Record<string, unknown>, observedAt: number, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    observedAt,
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
  }
}

const initFrame = (at: number) =>
  frame({ type: 'system', subtype: 'init', uuid: `init-${at}`, model: 'claude-fable-5-1[1m]' }, at)

const userFrame = (uuid: string, at: number) =>
  frame(
    { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    at,
    true
  )

const assistantFrame = (uuid: string, at: number, input: number, model = 'claude-fable-5-1') =>
  frame(
    {
      type: 'assistant',
      uuid,
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text: uuid }],
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 4
        }
      }
    },
    at
  )

const resultFrame = (at: number, contextWindow = 1_000_000) =>
  frame(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      duration_ms: 10,
      uuid: `result-${at}`,
      modelUsage: { 'claude-fable-5-1[1m]': { contextWindow } }
    },
    at
  )

const compactBoundary = (at: number) =>
  frame(
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `compact-${at}`,
      compact_metadata: { trigger: 'manual', pre_tokens: 150_000 }
    },
    at
  )

const postCompactionReport = {
  model: 'claude-fable-5-1[1m]',
  totalTokens: 40_000,
  rawMaxTokens: 1_000_000,
  percentage: 4,
  categories: [{ name: 'Messages', tokens: 30_000 }]
}

async function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    },
    now: () => 9_000,
    journalDir: join(root, 'orca-session')
  })
}

/** One acquisition: a fresh sink and translator over the session's journal. */
function acquire(journal: AgentSessionJournal) {
  const deferred = createDeferredStructuredAgentSessionEventSink()
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const answers: ((value: unknown) => void)[] = []
  const unbind = bindClaudeContextUsageCapture(
    {
      getContextUsage: () => new Promise((resolve) => answers.push(resolve))
    },
    translator,
    { now: () => 20_000 }
  )
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve()
    }
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  const detach = (): void => deferred.unbind()
  const reattach = (): void => deferred.bind({ journal, fence: 1, publish: () => {} })
  const release = (): void => {
    unbind?.()
    translator.dispose()
    deferred.close()
  }
  return { translator, answers, settle, detach, reattach, release }
}

const ring = (journal: AgentSessionJournal) =>
  selectStructuredAgentContextUsage(journal.snapshot().items)

describe('context usage across a restart', () => {
  it('resets the ring at a /compact that is the first thing after a restart, then reads the fresh report', async () => {
    const journal = await openJournal()
    const before = acquire(journal)
    before.translator.handle(initFrame(900))
    before.translator.handle(userFrame('turn-a', 1_000))
    before.translator.handle(assistantFrame('reply-a', 2_000, 150_000))
    before.translator.handle(resultFrame(3_000))
    await before.settle()
    expect(ring(journal)).toMatchObject({ usedTokens: 150_000, windowTokens: 1_000_000 })
    before.release()

    // A new acquisition builds a new translator; it holds no turn of its own.
    const after = acquire(journal)
    after.translator.handle(compactBoundary(10_000))
    await after.settle()
    expect(ring(journal)).toBeNull()

    after.translator.handle(resultFrame(11_000))
    await after.settle()
    expect(ring(journal)).toBeNull()
    after.answers.at(-1)?.(postCompactionReport)
    await after.settle()
    expect(ring(journal)).toMatchObject({
      usedTokens: 40_000,
      windowTokens: 1_000_000,
      estimated: false,
      categories: [{ name: 'Messages', tokens: 30_000 }]
    })
    after.release()
  })

  it('reads the ring from the journal after a restart, and adopts the first response model', async () => {
    const journal = await openJournal()
    const before = acquire(journal)
    before.translator.handle(initFrame(900))
    before.translator.handle(userFrame('turn-a', 1_000))
    before.translator.handle(assistantFrame('reply-a', 2_000, 150_000))
    before.translator.handle(resultFrame(3_000))
    await before.settle()
    before.release()

    const after = acquire(journal)
    expect(ring(journal)).toMatchObject({ usedTokens: 150_000, windowTokens: 1_000_000 })
    after.translator.handle(initFrame(9_900))
    after.translator.handle(userFrame('turn-b', 10_000))
    after.translator.handle(assistantFrame('reply-b', 11_000, 160_000))
    await after.settle()
    expect(ring(journal)).toMatchObject({ usedTokens: 160_000, windowTokens: 1_000_000 })
    // Adopted: a response on another model says the journal's window no longer serves.
    after.translator.handle(assistantFrame('reply-b2', 12_000, 170_000, 'claude-sonnet-5'))
    await after.settle()
    expect(ring(journal)).toBeNull()
    after.release()
  })

  it('keeps the last known size of a turn the child crashed in', async () => {
    const journal = await openJournal()
    const crashed = acquire(journal)
    crashed.translator.handle(initFrame(900))
    crashed.translator.handle(userFrame('turn-a', 1_000))
    crashed.translator.handle(assistantFrame('reply-a', 2_000, 20_000))
    crashed.translator.handle(resultFrame(3_000))
    crashed.translator.handle(initFrame(3900))
    crashed.translator.handle(userFrame('turn-b', 4_000))
    crashed.translator.handle(assistantFrame('reply-b', 5_000, 120_000))
    await crashed.settle()
    // The child dies with turn-b running; nothing ends it from the provider side.
    crashed.release()

    await settleStaleSessionStateOnAcquire({
      journal,
      sessionId: 'orca-session',
      fence: 2,
      acquisitionGeneration: 'next'
    })
    const turns = journal.snapshot().items.map((item) => readAgentJournalTurn(item.body)?.state)
    expect(turns).toContain('unverifiable')
    expect(ring(journal)).toMatchObject({ usedTokens: 120_000, windowTokens: 1_000_000 })
  })

  it('never brings a settled turn back to running with a context write that ran late', async () => {
    const journal = await openJournal()
    const live = acquire(journal)
    live.translator.handle(initFrame(900))
    live.translator.handle(userFrame('turn-a', 1_000))
    live.translator.handle(assistantFrame('reply-a', 2_000, 20_000))
    await live.settle()
    // The write is queued while the host settles the turn behind the sink's back.
    live.detach()
    live.translator.handle(assistantFrame('reply-a2', 3_000, 30_000))
    await settleStaleSessionStateOnAcquire({
      journal,
      sessionId: 'orca-session',
      fence: 1,
      acquisitionGeneration: 'next'
    })
    live.reattach()
    await live.settle()
    const turn = journal
      .snapshot()
      .items.map((item) => readAgentJournalTurn(item.body))
      .find(Boolean)
    expect(turn).toMatchObject({
      state: 'unverifiable',
      contextUsage: { used: { kind: 'estimate', usage: { inputTokens: 30_000 } } }
    })
    live.release()
  })

  it("reads a new session's implied window the same from its loaded rows and from the host", async () => {
    const journal = await openJournal()
    const live = acquire(journal)
    live.translator.modelWritten('opus[1m]')
    live.translator.handle(initFrame(900))
    live.translator.handle(userFrame('turn-a', 1_000))
    live.translator.handle(assistantFrame('reply-a', 2_000, 150_000))
    await live.settle()
    const expected = { usedTokens: 150_000, windowTokens: 1_000_000, percentage: 15 }
    expect(ring(journal)).toMatchObject(expected)
    expect(journal.contextUsage()).toMatchObject({ window: { tokens: 1_000_000 } })
    // A client whose loaded page lacks the turn reads the host's answer.
    expect(selectStructuredAgentContextUsage([], journal.contextUsage())).toMatchObject(expected)
    live.release()
  })

  it('keeps the window a restarted journal holds over the one the model name implies', async () => {
    const journal = await openJournal()
    const before = acquire(journal)
    before.translator.handle(initFrame(900))
    before.translator.handle(userFrame('turn-a', 1_000))
    before.translator.handle(assistantFrame('reply-a', 2_000, 150_000))
    before.translator.handle(resultFrame(3_000, 400_000))
    await before.settle()
    before.release()

    const after = acquire(journal)
    after.translator.modelWritten('fable[1m]')
    after.translator.handle(initFrame(9_900))
    after.translator.handle(userFrame('turn-b', 10_000))
    after.translator.handle(assistantFrame('reply-b', 11_000, 160_000))
    await after.settle()
    expect(ring(journal)).toMatchObject({ usedTokens: 160_000, windowTokens: 400_000 })
    expect(journal.contextUsage().window).toEqual({ tokens: 400_000, capturedAt: 3_000 })
    after.release()
  })
})
