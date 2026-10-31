import type * as DeltaCoalescerModule from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import type {
  JournalItemRow,
  JournalRow
} from '../native-chat/agent-session-journal/journal-row-schema'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

// Observe real full-value materialization at the public coalescer boundary; never replace admission.
const fullValues = vi.hoisted(() => {
  const state: { texts: string[] } = { texts: [] }
  return state
})
vi.mock('../native-chat/agent-session-wire/agent-session-delta-coalescer', async (original) => {
  const actual = await original<typeof DeltaCoalescerModule>()
  const record = (text: string) => {
    fullValues.texts.push(text)
  }
  return {
    ...actual,
    createAgentSessionDeltaCoalescer: (
      deps: Parameters<typeof actual.createAgentSessionDeltaCoalescer>[0]
    ) => {
      const coalescer = actual.createAgentSessionDeltaCoalescer({
        ...deps,
        emit: (key, text, snapshot) => {
          record(text)
          return deps.emit(key, text, snapshot)
        }
      })
      return {
        ...coalescer,
        snapshot: (key: string) => {
          const value = coalescer.snapshot(key)
          if (value) {
            record(value.text)
          }
          return value
        },
        dirty: (...args: Parameters<typeof coalescer.dirty>) => {
          const values = coalescer.dirty(...args)
          values.forEach((value) => record(value.snapshot.text))
          return values
        }
      }
    }
  }
})

const SESSION = 'session-codex-context'
const THREAD = 'thread-main'

// `tokenUsage` payloads captured from `codex app-server` 0.161.0, in the order one thread sent them.
const FIRST_RESPONSE = {
  total: usage(17611, 17606, 12288, 5),
  last: usage(17611, 17606, 12288, 5),
  modelContextWindow: 258400
}
const AFTER_TOOL_CALL = {
  total: usage(35295, 35241, 24576, 54),
  last: usage(17684, 17635, 12288, 49),
  modelContextWindow: 475000
}
const FINAL_RESPONSE = {
  total: usage(53009, 52950, 41984, 59),
  last: usage(17714, 17709, 17408, 5),
  modelContextWindow: 475000
}
const AFTER_COMPACTION = {
  total: usage(53009, 52950, 41984, 59),
  last: usage(6033, 0, 0, 0),
  modelContextWindow: 475000
}

function usage(
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
) {
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0
  }
}

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-context-usage-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    stateDirectory: root,
    now: () => 1_000
  })
  cleanups.push(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const connect = () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: () => {} })
    cleanups.unshift(async () => deferred.close())
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      sessionId: SESSION,
      primaryThreadId: () => THREAD,
      // Supply dispatch timing so echoes can revise the turn row.
      dispatchRequestOrigin: () => ({ requestedAt: 900, sequence: 0 })
    })
    const on = (method: string, params: Record<string, unknown>, threadId = THREAD) =>
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId,
        method,
        params: { threadId, ...params }
      })
    return {
      translator,
      deferred,
      on,
      tokenUsage: (turnId: string, tokenUsage: unknown, threadId = THREAD) =>
        on('thread/tokenUsage/updated', { turnId, tokenUsage }, threadId),
      contextUsage: async () => {
        await expect(deferred.drained()).resolves.toEqual({ ok: true })
        return selectStructuredAgentContextUsage(journal.snapshot().items)
      },
      turnRecord: async (turnId: string) => {
        await expect(deferred.drained()).resolves.toEqual({ ok: true })
        return journal
          .snapshot()
          .items.map((item) => readAgentJournalTurn(item.body))
          .find((turn) => turn?.turnId === turnId)
      }
    }
  }
  return { journal, connect, ...connect() }
}

describe('Codex context usage in the journal', () => {
  it('follows each response of a turn and holds once the turn ends', async () => {
    const { on, tokenUsage, contextUsage } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })

    tokenUsage('turn-1', FIRST_RESPONSE)
    expect(await contextUsage()).toEqual({
      usedTokens: 17611,
      windowTokens: 258400,
      percentage: 7,
      estimated: false,
      categories: []
    })

    // Context usage measures the response, not cumulative thread spend.
    tokenUsage('turn-1', AFTER_TOOL_CALL)
    expect(await contextUsage()).toMatchObject({ usedTokens: 17684, windowTokens: 475000 })

    tokenUsage('turn-1', FINAL_RESPONSE)
    on('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(await contextUsage()).toMatchObject({ usedTokens: 17714, windowTokens: 475000 })
  })

  it.each([
    ['while the turn runs', false],
    ['after the turn ended', true]
  ])("holds when a send's echo revises the turn row %s", async (_when, ended) => {
    const { on, tokenUsage, contextUsage, turnRecord } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FINAL_RESPONSE)
    if (ended) {
      on('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    }

    on('item/started', {
      turnId: 'turn-1',
      item: { type: 'userMessage', id: 'user-1', clientId: 'client-1' }
    })

    expect(await turnRecord('turn-1')).toMatchObject({ requestedAt: 900 })
    expect(await contextUsage()).toMatchObject({ usedTokens: 17714, windowTokens: 475000 })
  })

  it('reads the size Codex restates after a compaction the user asked for', async () => {
    const { journal, translator, on, tokenUsage, contextUsage } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FINAL_RESPONSE)
    on('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    // The host owns the command's turn row; the provider turn creates none.
    const identity: AgentJournalItemIdentity = {
      provider: 'orca',
      clientMessageId: 'command-turn:cmd-1'
    }
    const running = { kind: 'turn' as const, turnId: 'compact:cmd-1', state: 'running' as const }
    await journal.appendItem(identity, running, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    translator.beginCommand({
      clientMessageId: 'cmd-1',
      turnId: running.turnId,
      identity,
      resultIdentity: { provider: 'orca', clientMessageId: 'command-result:cmd-1' },
      running
    })
    on('turn/started', { turn: { id: 'compact-turn' } })
    tokenUsage('compact-turn', AFTER_COMPACTION)
    on('item/completed', {
      turnId: 'compact-turn',
      item: { type: 'contextCompaction', id: 'compaction' }
    })
    on('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })

    expect(await contextUsage()).toMatchObject({ usedTokens: 6033, windowTokens: 475000 })
  })

  it("leaves the session's reading alone when a helper thread reports its own", async () => {
    const { on, tokenUsage, contextUsage } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FINAL_RESPONSE)

    tokenUsage('helper-turn', FIRST_RESPONSE, 'thread-helper')

    expect(await contextUsage()).toMatchObject({ usedTokens: 17714, windowTokens: 475000 })
  })

  it('shows nothing once Codex names no window to measure against', async () => {
    const { on, tokenUsage, contextUsage } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FIRST_RESPONSE)
    expect(await contextUsage()).toMatchObject({ usedTokens: 17611 })

    tokenUsage('turn-1', { ...AFTER_TOOL_CALL, modelContextWindow: null })

    expect(await contextUsage()).toBeNull()
  })

  it('holds a reading that reached the open turn row under another turn name', async () => {
    const { on, tokenUsage, contextUsage } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FINAL_RESPONSE)
    // An unknown turn falls back to the newest row.
    tokenUsage('turn-nobody-opened', AFTER_COMPACTION)

    on('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    expect(await contextUsage()).toMatchObject({ usedTokens: 6033, windowTokens: 475000 })
  })

  it('keeps the saved reading through a resume that restores history, then takes the replayed frame', async () => {
    const { on, tokenUsage, connect } = await session()
    on('turn/started', { turn: { id: 'turn-1' } })
    tokenUsage('turn-1', FIRST_RESPONSE)
    on('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    const resumed = connect()
    resumed.translator.restoreThread(THREAD, {
      turns: [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2, items: [] }]
    })
    expect(await resumed.turnRecord('turn-1')).toMatchObject({ completedAt: 2_000 })
    expect(await resumed.contextUsage()).toMatchObject({ usedTokens: 17611, windowTokens: 258400 })

    // After resume, the provider's turn ID may differ from the saved command row's ID.
    resumed.tokenUsage('turn-before-restart', FINAL_RESPONSE)
    expect(await resumed.contextUsage()).toMatchObject({ usedTokens: 17714, windowTokens: 475000 })
  })
})

it('metadata-barrier-class-confirmation', async () => {
  const observations = []
  for (const type of ['agentMessage', 'reasoning'] as const) {
    for (const withUsage of [false, true]) {
      const r = await session()
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
      try {
        vi.setSystemTime(100000)
        const inputs: JournalRow[] = []
        r.journal.observeCommits((rows) => inputs.push(...(rows ?? [])))
        r.on('turn/started', { turn: { id: 'turn' } })
        r.on('item/started', { turnId: 'turn', item: { type, id: 'text' } })
        const delta =
          type === 'agentMessage' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta'
        const prefix = 'P'.repeat(100),
          tail = 'T'.repeat(40)
        r.on(delta, { itemId: 'text', delta: prefix })
        await vi.advanceTimersByTimeAsync(60)
        await r.deferred.drained()
        const first = r.journal.snapshot().items.find((item) => item.body.kind === 'message')!
        expect(first.body).toMatchObject({ blocks: [{ type: 'text', text: prefix }] })
        await vi.advanceTimersByTimeAsync(40)
        r.on(delta, { itemId: 'text', delta: tail })
        await vi.advanceTimersByTimeAsync(10)
        const before = fullValues.texts.length
        if (withUsage) {
          r.tokenUsage('turn', FIRST_RESPONSE)
        }
        await r.deferred.drained()
        const text = inputs.filter(
          (row): row is JournalItemRow => row.kind === 'item' && row.body.kind === 'message'
        )
        observations.push({
          type,
          withUsage,
          joins: fullValues.texts.length - before,
          saves: text.length,
          bodyBytes: text.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.body)), 0),
          context: await r.contextUsage()
        })
        r.translator.flush()
        await r.deferred.drained()
        expect(
          r.journal.snapshot().items.find((item) => item.itemId === first.itemId)
        ).toMatchObject({
          ...first,
          revision: first.revision + 1,
          body: { blocks: [{ type: 'text', text: prefix + tail }] }
        })
      } finally {
        r.translator.dispose()
        vi.useRealTimers()
      }
    }
  }
  console.info('metadata-barrier-class-confirmation', JSON.stringify(observations))
  expect(
    observations.map(({ type, withUsage, joins, saves }) => ({ type, withUsage, joins, saves }))
  ).toEqual(
    ['agentMessage', 'reasoning'].flatMap((type) =>
      [false, true].map((withUsage) => ({ type, withUsage, joins: 0, saves: 1 }))
    )
  )
})

it('usage leaves the existing autonomous plan wake and arrival-driven assistant tail independent', async () => {
  const r = await session()
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  try {
    r.tokenUsage('missing', FIRST_RESPONSE)
    await r.deferred.drained()
    expect(r.journal.snapshot().items).toEqual([])
    r.on('turn/started', { turn: { id: 'turn' } })
    r.on('item/plan/delta', { itemId: 'plan', delta: 'Plan' })
    r.on('item/agentMessage/delta', { itemId: 'assistant', delta: 'Answer' })
    await vi.advanceTimersByTimeAsync(60)
    await r.deferred.drained()
    const original = structuredClone(r.journal.snapshot().items)
    await vi.advanceTimersByTimeAsync(40)
    r.on('item/plan/delta', { itemId: 'plan', delta: ' tail' })
    r.on('item/agentMessage/delta', { itemId: 'assistant', delta: ' tail' })
    await vi.advanceTimersByTimeAsync(10)
    r.tokenUsage('turn', FIRST_RESPONSE)
    await r.deferred.drained()
    expect(r.journal.snapshot().items.filter((item) => item.body.kind !== 'turn')).toEqual(
      original.filter((item) => item.body.kind !== 'turn')
    )
    await vi.advanceTimersByTimeAsync(349)
    await r.deferred.drained()
    expect(
      r.journal.snapshot().items.find((item) => item.body.kind === 'status')?.body
    ).toMatchObject({ text: 'Plan' })
    await vi.advanceTimersByTimeAsync(1)
    await r.deferred.drained()
    expect(
      r.journal.snapshot().items.find((item) => item.body.kind === 'status')?.body
    ).toMatchObject({ text: 'Plan tail' })
    expect(
      r.journal.snapshot().items.find((item) => item.body.kind === 'message')?.body
    ).toMatchObject({ blocks: [{ type: 'text', text: 'Answer' }] })
    r.on('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    await r.deferred.drained()
    expect(
      r.journal.snapshot().items.find((item) => item.body.kind === 'message')?.body
    ).toMatchObject({ blocks: [{ type: 'text', text: 'Answer tail' }] })
  } finally {
    r.translator.dispose()
    vi.useRealTimers()
  }
})
