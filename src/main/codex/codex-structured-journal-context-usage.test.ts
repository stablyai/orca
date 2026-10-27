import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

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
