import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  fakeCodex,
  adapterFor,
  identityFor,
  acquireReadyCodexForTest
} from '../session-lifecycle/codex-structured-session-adapter-fixture'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionRevisionJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import {
  createCodexHistoryTranslator,
  createCodexJournalTranslator
} from '../journal/codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION = 'session-1'
const THREAD = 'thread-1'
const PROVIDER_TURN = 'compact-turn'
const COMMAND_TURN_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_TURN_KEY = agentJournalItemKey(COMMAND_TURN_IDENTITY)
const RUNNING = {
  kind: 'turn' as const,
  turnId: 'compact:cmd-1',
  state: 'running' as const,
  userItemId: 'orca:submission:cmd-1',
  requestedAt: 1,
  startedAt: 1
}
const COMMAND = {
  clientMessageId: 'cmd-1',
  turnId: RUNNING.turnId,
  identity: COMMAND_TURN_IDENTITY,
  resultIdentity: { provider: 'orca' as const, clientMessageId: 'command-result:cmd-1' },
  running: RUNNING
}
const ACCEPTED: StructuredAgentSessionSinkAdmission = { accepted: true }

type Written = { key: string; body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }

function recorder(refuseRevisions = 0) {
  const writes: Written[] = []
  const record = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope?: AgentJournalTurnScope
  ) => writes.push({ key: agentJournalItemKey(identity), body, turnScope })
  const commandTurn: AgentJournalItemBody = RUNNING
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim resolver reads only `itemBody`.
  const journal = {
    itemBody: (itemId: string) => (itemId === COMMAND_TURN_KEY ? commandTurn : null)
  } as unknown as StructuredAgentSessionRevisionJournal
  let refusals = refuseRevisions
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => record(identity, body, options.turnScope),
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => ACCEPTED,
    tryAppendItem: (identity, body, options) => {
      record(identity, body, options.turnScope)
      return ACCEPTED
    },
    appendLifecycleBatch: (_settlementId, mutations) => {
      for (const mutation of mutations) {
        if (mutation.kind === 'item') {
          record(mutation.identity, mutation.body, mutation.turnScope)
        }
      }
    },
    tryReviseResolvedItemAndPublish: (_bytes, resolve, options) => {
      if (refusals > 0) {
        refusals -= 1
        return { accepted: false, reason: 'backpressure' }
      }
      const resolved = resolve(journal)
      if (resolved) {
        record(resolved.identity, resolved.body, options.turnScope)
      }
      return ACCEPTED
    }
  }
  return { sink, writes }
}

function notification(
  method: string,
  params: Record<string, unknown>
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION,
    threadId: THREAD,
    method,
    params: { threadId: THREAD, ...params }
  }
}

function harness(refuseRevisions = 0) {
  const tap = recorder(refuseRevisions)
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD
  })
  return {
    ...tap,
    translator,
    emit: (event: CodexStructuredSessionEvent) => translator.handle(event)
  }
}

const codexTurnRecords = (writes: readonly Written[]) =>
  writes.filter((write) => write.key !== COMMAND_TURN_KEY && readAgentJournalTurn(write.body))

const commandTurn = (writes: readonly Written[]) =>
  readAgentJournalTurn(writes.findLast((write) => write.key === COMMAND_TURN_KEY)?.body)

const resultRows = (writes: readonly Written[]) =>
  writes.filter((write) => write.body.kind === 'status')

describe('a Codex turn a conversation command claims', () => {
  it("ends a captured failed compaction on its completion, below one row of Codex's own", () => {
    // Captured app-server sequence: two retries, a fatal error, then failed completion.
    const captured: { case: string; t: number; method: string; params: object }[] = readFileSync(
      join(__dirname, '../../__fixtures__/codex-app-server-turn-endings.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.case === '0.158.0-compact-overloaded')
    const compactionTurn = captured.findLastIndex((frame) => frame.method === 'turn/started')
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    for (const frame of captured.slice(compactionTurn)) {
      emit({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method: frame.method,
        params: { ...frame.params, threadId: THREAD },
        observedAt: frame.t
      })
    }

    expect(codexTurnRecords(writes)).toEqual([])
    const completion = captured.at(-1)!
    expect(completion.method).toBe('turn/completed')
    expect(commandTurn(writes)).toMatchObject({
      state: 'completed',
      outcome: 'failure',
      completedAt: completion.t
    })
    const scope = { kind: 'turn', turnItemId: COMMAND_TURN_KEY }
    const rows = resultRows(writes)
    expect(rows.map((write) => write.key)).not.toContain(
      agentJournalItemKey(COMMAND.resultIdentity)
    )
    expect(rows.map((write) => write.turnScope)).toEqual(rows.map(() => scope))
    const failures = rows.filter(
      (write) => write.body.kind === 'status' && write.body.tone === 'error'
    )
    expect(failures.map((write) => write.body)).toMatchObject([
      {
        kind: 'status',
        failure: { kind: 'providerUnavailable' },
        providerFrame: {
          payload: {
            head: expect.stringContaining('Selected model is at capacity')
          }
        }
      }
    ])
  })

  it('leaves the next turn to write its own record after a failed compaction', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(
      notification('error', { turnId: PROVIDER_TURN, willRetry: false, error: { message: 'x' } })
    )
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'failed' } }))
    emit(notification('turn/started', { turn: { id: 'ordinary' } }))
    emit(notification('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }))

    expect(
      codexTurnRecords(writes).map((write) => readAgentJournalTurn(write.body)?.turnId)
    ).toEqual(['ordinary', 'ordinary'])
  })

  it('names no provider turn for a Stop until Codex opens one, then the one it opened', () => {
    const { translator, emit } = harness()
    translator.beginCommand(COMMAND)
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBeUndefined()
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
    expect(translator.commandProviderTurnId('ordinary')).toBe('ordinary')
  })

  it('claims the same provider turn when the refused start is retried', () => {
    const { writes, translator, emit } = harness(1)
    translator.beginCommand(COMMAND)
    const started = notification('turn/started', { turn: { id: PROVIDER_TURN } })

    expect(emit(started)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(emit(started)).toEqual(ACCEPTED)

    expect(codexTurnRecords(writes)).toEqual([])
    expect(commandTurn(writes)).toMatchObject({ providerTurnId: PROVIDER_TURN })
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
  })
})

// Codex 0.167.0, native review/start captured against a changed sum.js with a live background terminal.
describe('native review notifications', () => {
  const frames: {
    id?: number
    result?: { turn: { id: string } }
    method?: string
    params?: Record<string, unknown>
  }[] = readFileSync(join(__dirname, '../../__fixtures__/codex-app-server-review.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  it.each([true, false])(
    'keeps one command turn and one findings message, reply received: %s',
    (replyReceived) => {
      const { translator, emit, writes } = harness()
      translator.beginCommand({ ...COMMAND, name: 'review', review: { type: 'custom' } })
      expect(translator.commandProviderTurnId(COMMAND.turnId)).toBeUndefined()
      for (const frame of frames) {
        if (frame.result && replyReceived) {
          translator.claimCommandTurn(frame.result.turn.id)
          expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(
            '01a1d7d0-fb1a-7130-a0ed-363bd0280c77'
          )
        }
        if (frame.method && frame.params) {
          expect(emit(notification(frame.method, frame.params))).toEqual(ACCEPTED)
        }
      }
      expect(codexTurnRecords(writes)).toEqual([])
      expect(commandTurn(writes)).toMatchObject({
        state: 'completed',
        outcome: 'success',
        providerTurnId: '01a1d7d0-fb1a-7130-a0ed-363bd0280c77'
      })
      const latest = [...new Map(writes.map((write) => [write.key, write.body])).values()]
      expect(latest.filter((body) => body.kind === 'message' && body.role === 'user')).toEqual([])
      expect(
        latest.filter((body) => body.kind === 'message' && body.role === 'assistant')
      ).toHaveLength(1)
      expect(latest.some((body) => body.kind === 'tool-call')).toBe(true)
      expect(
        resultRows(writes).filter(
          (write) => write.body.kind === 'status' && write.body.tone === 'error'
        )
      ).toEqual([])
    }
  )
  it('imports findings without the review rubric or mode markers', () => {
    const { sink, writes } = recorder()
    const translator = createCodexHistoryTranslator({
      sink,
      sessionId: SESSION,
      primaryThreadId: () => THREAD
    })
    const items = frames
      .filter((frame) => frame.method === 'item/completed')
      .map((frame) => frame.params?.item)
    expect(
      translator.restoreThread(THREAD, {
        turns: [{ id: 'review-turn', status: 'completed', items }]
      })
    ).toEqual(ACCEPTED)
    const latest = [...new Map(writes.map((write) => [write.key, write.body])).values()]
    expect(latest.filter((body) => body.kind === 'message' && body.role === 'user')).toEqual([])
    expect(
      latest.filter((body) => body.kind === 'message' && body.role === 'assistant')
    ).toHaveLength(1)
    translator.dispose()
  })
})

it('installs captured settings before native review and binds Stop at the reply', async () => {
  const codex = fakeCodex({ 'review/start': () => ({ turn: { id: 'review-native' } }) })
  const adapter = adapterFor(codex)
  const tap = recorder()
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: tap.sink
  })
  const outcome = await adapter.review({
    sessionId: SESSION,
    fence: 7,
    command: { ...COMMAND, name: 'review', review: { type: 'baseBranch', branch: 'main' } },
    executionOptions: { model: 'gpt-review', effort: 'high' }
  })
  expect(outcome.state).toBe('accepted')
  expect(
    codex.connections[0]!.calls.filter((call) =>
      ['thread/settings/update', 'review/start'].includes(call.method)
    )
  ).toEqual([
    {
      method: 'thread/settings/update',
      params: { threadId: 'thread-abc', model: 'gpt-review', effort: 'high' }
    },
    {
      method: 'review/start',
      params: {
        threadId: 'thread-abc',
        target: { type: 'baseBranch', branch: 'main' },
        delivery: 'inline'
      }
    }
  ])
  expect(
    await adapter.cancelTurn({ sessionId: SESSION, fence: 7, turnId: COMMAND.turnId })
  ).toMatchObject({ cancelled: true })
  expect(codex.connections[0]!.calls.at(-1)).toEqual({
    method: 'turn/interrupt',
    params: { threadId: 'thread-abc', turnId: 'review-native' }
  })
  await adapter.closeAll()
})

it('keeps an uncertain review armed for late events but forgets a rejected review', async () => {
  const reply = Promise.withResolvers<unknown>()
  const codex = fakeCodex({ 'review/start': () => reply.promise })
  const adapter = adapterFor(codex)
  const tap = recorder()
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9',
    events: tap.sink
  })
  const command = {
    ...COMMAND,
    name: 'review' as const,
    review: { type: 'uncommittedChanges' as const }
  }
  const running = adapter.review({ sessionId: SESSION, fence: 7, command })
  await vi.waitFor(() => expect(codex.connections[0]!.calls.at(-1)?.method).toBe('review/start'))
  expect(
    await adapter.cancelTurn({ sessionId: SESSION, fence: 7, turnId: COMMAND.turnId })
  ).toEqual({ cancelled: false })
  reply.reject(new Error('request timed out'))
  await expect(running).rejects.toThrow('request timed out')
  codex.connections[0]!.handlers.onNotification?.('item/started', {
    threadId: 'thread-abc',
    turnId: 'late-review',
    item: { type: 'enteredReviewMode', id: 'mode', review: 'uncommitted changes' }
  })
  expect(
    await adapter.cancelTurn({ sessionId: SESSION, fence: 7, turnId: COMMAND.turnId })
  ).toMatchObject({ cancelled: true })
  expect(codex.connections[0]!.calls.at(-1)?.params).toEqual({
    threadId: 'thread-abc',
    turnId: 'late-review'
  })
  codex.connections[0]!.handlers.onNotification?.('turn/completed', {
    threadId: 'thread-abc',
    turn: { id: 'late-review', status: 'interrupted' }
  })
  expect(commandTurn(tap.writes)).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  codex.routes['review/start'] = () => {
    throw new CodexAppServerRequestError('review/start', -32602, 'invalid target')
  }
  expect(await adapter.review({ sessionId: SESSION, fence: 7, command })).toMatchObject({
    state: 'rejected',
    rejection: { kind: 'reviewFailed' }
  })
  await adapter.closeAll()
})

it('admits a normal turn after a review request times out without entering review', async () => {
  const codex = fakeCodex({
    'review/start': () => {
      throw new Error('request timed out')
    }
  })
  const adapter = adapterFor(codex)
  const tap = recorder()
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 7,
      spawnToken: 'spawn-9',
      events: tap.sink
    })
    await expect(
      adapter.review({
        sessionId: SESSION,
        fence: 7,
        command: { ...COMMAND, name: 'review', review: { type: 'custom' } }
      })
    ).rejects.toThrow('request timed out')
    const notify = codex.connections[0]!.handlers.onNotification!
    notify('turn/started', {
      threadId: 'thread-abc',
      turn: { id: 'normal-turn', rootTurnId: null }
    })
    notify('item/completed', {
      threadId: 'thread-abc',
      turnId: 'normal-turn',
      item: { id: 'normal-user', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }
    })
    expect(codexTurnRecords(tap.writes)).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ turnId: 'normal-turn', state: 'running' })
      })
    )
  } finally {
    await adapter.closeAll()
  }
})

it('uses the reported settings for a first review without an unnecessary settings update', async () => {
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 7,
      spawnToken: 'spawn-9'
    })
    expect(
      await adapter.review({
        sessionId: SESSION,
        fence: 7,
        command: { ...COMMAND, name: 'review', review: { type: 'custom' } },
        executionOptions: { model: 'gpt-live', effort: 'medium' }
      })
    ).toMatchObject({ state: 'accepted' })
    expect(
      codex.connections[0]!.calls.filter(({ method }) => method === 'thread/settings/update')
    ).toEqual([])
  } finally {
    await adapter.closeAll()
  }
})

it('corrects captured settings after an applied update loses its reply', async () => {
  let model = 'gpt-live'
  let effort = 'medium'
  let loseReply = true
  const reviewed: { model: string; effort: string }[] = []
  const codex = fakeCodex({
    'thread/settings/update': (params) => {
      model = String(params?.model)
      effort = String(params?.effort)
      if (loseReply) {
        loseReply = false
        throw new Error('settings reply timed out')
      }
      return {}
    },
    'review/start': () => {
      reviewed.push({ model, effort })
      return { turn: { id: 'review-native' } }
    }
  })
  const adapter = adapterFor(codex)
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 7,
      spawnToken: 'spawn-9'
    })
    const command = { ...COMMAND, name: 'review' as const, review: { type: 'custom' as const } }
    expect(
      await adapter.review({
        sessionId: SESSION,
        fence: 7,
        command,
        executionOptions: { model: 'gpt-review', effort: 'high' }
      })
    ).toMatchObject({ state: 'rejected' })
    expect(reviewed).toEqual([])
    expect(
      await adapter.review({
        sessionId: SESSION,
        fence: 7,
        command,
        executionOptions: { model: 'gpt-live', effort: 'medium' }
      })
    ).toMatchObject({ state: 'accepted' })
    expect(
      codex.connections[0]!.calls.filter(
        ({ method }) => method === 'thread/settings/update' || method === 'review/start'
      ).map(({ method, params }) => ({ method, model: params?.model, effort: params?.effort }))
    ).toEqual([
      { method: 'thread/settings/update', model: 'gpt-review', effort: 'high' },
      { method: 'thread/settings/update', model: 'gpt-live', effort: 'medium' },
      { method: 'review/start', model: undefined, effort: undefined }
    ])
    expect(reviewed).toEqual([{ model: 'gpt-live', effort: 'medium' }])
  } finally {
    await adapter.closeAll()
  }
})

it('cleans the main thread terminals with one native operation and no subagent interruption', async () => {
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9'
  })
  const before = codex.connections[0]!.calls.length
  await adapter.cleanBackgroundTerminals({ sessionId: SESSION, fence: 7 })
  expect(codex.connections[0]!.calls.slice(before)).toEqual([
    { method: 'thread/backgroundTerminals/clean', params: { threadId: 'thread-abc' } }
  ])
  codex.routes['thread/backgroundTerminals/clean'] = () => {
    throw new CodexAppServerRequestError('thread/backgroundTerminals/clean', -32601, 'unsupported')
  }
  await expect(adapter.cleanBackgroundTerminals({ sessionId: SESSION, fence: 7 })).rejects.toThrow(
    "This Codex version can't stop background terminals from chat. Update Codex."
  )
  await adapter.closeAll()
  await expect(
    adapter.cleanBackgroundTerminals({ sessionId: SESSION, fence: 7 })
  ).resolves.toBeUndefined()
})
