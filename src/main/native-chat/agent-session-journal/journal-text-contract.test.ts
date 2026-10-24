import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { CodexTurnOrdinals } from '../../codex/codex-turn-ordinals'
import { codexLiveTextKey } from '../../codex/codex-thread-item-identity'
import { join } from 'node:path'
import { afterEach, assert, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { iterateJournalEpochRows } from './journal-row-table'
import { replayJournal } from './journal-open'
import { JournalTextIndex } from './journal-text-index'
import { planStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-stale-state-settlement'
import { planStructuredAgentSessionDeadGeneration } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createClaudeStreamedTextCheckpoints } from '../../claude/claude-streamed-text-checkpoints'
import { AgentSessionSubscribers } from '../agent-session-wire/structured-agent-session-subscribers'
import { subscriberHistoryReader } from '../agent-session-wire/agent-session-bounded-frames'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'

import {
  rootTextProducer,
  textJournals as journals,
  flushJournalTextIdle,
  closeTextJournals,
  textRig as rig,
  textBody as body,
  textOptions as options,
  textIdentityOf as identity
} from './journal-text-test-support'
afterEach(async () => {
  vi.restoreAllMocks()
  await closeTextJournals()
})

it('charges advancing sparse/protected work at N and 10N', async () => {
  for (const n of [30, 300]) {
    const r = await rig()
    const selected: number[] = []
    const select = JournalTextIndex.prototype.select
    const spy = vi.spyOn(JournalTextIndex.prototype, 'select').mockImplementation(function (
      this: JournalTextIndex,
      ...args
    ) {
      const unit = select.apply(this, args)
      selected.push(unit.examined)
      expect(unit.ranges.length).toBeLessThanOrEqual(128)
      return unit
    })
    const max = vi.spyOn(Math, 'max')
    const a = identity(`a-${n}`),
      b = identity(`b-${n}`)
    for (let k = 0; k <= n; k++) {
      await r.append(a, k)
      await r.append(b, k)
    }
    expect(selected).toEqual([])
    const old = r.rows().filter((row) => row.kind === 'text-delta')
    const historical = identity('historical'),
      auxiliary = identity('auxiliary')
    await r.append(auxiliary, 0, 9)
    for (let k = 0; k < n; k++) {
      const attribution = { ...options, fence: n + 8, executionOwner: 8 + k }
      await r.journal.appendItem(historical, body('a'), {
        ...attribution,
        ...(k === 0
          ? { streamText: { operation: 'start' as const, field: 0, baseLength: 0, suffix: 'a' } }
          : {})
      })
      await r.journal.appendItem(historical, body(''), {
        ...attribution,
        streamText: { operation: 'append', field: 0, baseLength: 1, suffix: 'a' }
      })
    }
    await r.journal.appendItem(historical, body('aa'), {
      ...options,
      fence: n + 8,
      recovered: true
    })
    const work = max.mock.calls.length
    await r.journal.appendItem(b, body('corrected'), { ...options, fence: n + 8 })
    await r.journal.appendItem(a, body('corrected'), { ...options, fence: n + 8 })
    await flushJournalTextIdle(r.journal)
    expect(selected.every((count) => count <= 256)).toBe(true)
    expect(selected.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(4 * n + 2)
    expect(max.mock.calls.length - work).toBeLessThan(80 * n * Math.log2(n + 1))
    expect(old.length).toBe(2 * n)
    const loaded = replayJournal(r.database.db, 'chat')
    expect(loaded?.damage).toBeNull()
    expect(loaded?.state.items.get(agentJournalItemKey(a))?.body).toEqual(body('corrected'))
    let owners = 0
    if (!loaded) {
      throw new Error('missing load')
    }
    const values = loaded.state.providerActivityWitness.values.bind(
      loaded.state.providerActivityWitness
    )
    loaded.state.providerActivityWitness.values = function* (): Generator<number, undefined> {
      for (const value of values()) {
        owners++
        yield value
      }
      return undefined
    }
    // The real shared fold must not enumerate the historical owner population.
    const { applyJournalRow } = await import('./journal-reducer')
    applyJournalRow(loaded.state, {
      v: 5,
      kind: 'item',
      epoch: r.journal.epoch,
      seq: loaded.state.lastSequence + 1,
      ts: Date.now(),
      fence: n + 8,
      itemId: 'claude:s:new',
      revision: 1,
      body: body('a'),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    applyJournalRow(loaded.state, {
      v: 5,
      kind: 'text-delta',
      epoch: r.journal.epoch,
      seq: loaded.state.lastSequence + 1,
      ts: Date.now(),
      fence: n + 8,
      itemId: 'claude:s:new',
      field: 0,
      revision: 2,
      predecessor: 1,
      baseLength: 1,
      suffix: 'b'
    })
    expect(owners).toBe(0)
    const completedExaminations = selected.reduce((sum, count) => sum + count, 0)
    selected.length = 0
    await r.journal.close()
    const reopened = await journals.open(r.settings)
    await flushJournalTextIdle(reopened)
    expect(selected.reduce((sum, count) => sum + count, 0)).toBe(n)
    expect(selected.every((count) => count <= 256)).toBe(true)
    console.info('text contract counts', {
      n,
      completedExaminations,
      parkedReopenExaminations: selected.reduce((sum, count) => sum + count, 0),
      historicalOwnerIterations: owners
    })
    selected.length = 0
    await reopened.appendItem(auxiliary, body(''), {
      ...options,
      fence: n + 8,
      ownerFence: 9,
      streamText: { operation: 'append', field: 0, baseLength: 1, suffix: 'b' }
    })
    await flushJournalTextIdle(reopened)
    expect(selected.reduce((sum, count) => sum + count, 0)).toBe(1)
    spy.mockRestore()
    max.mockRestore()
  }
})

it('fully validates witnesses once per transaction and rechecks local/external corruption', async () => {
  const r = await rig(),
    id = identity('validation')
  await r.append(id, 0)
  for (let k = 1; k <= 600; k++) {
    await r.append(id, k)
  }
  const parse = JSON.parse
  let sourceDecodes = 0
  const decoding = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (typeof text === 'string' && text.includes('large-whole-tag')) {
      sourceDecodes++
    }
    return parse(text, reviver)
  })
  const old = await rig()
  await old.journal.appendItem(identity('old'), body('large-whole-tag'), options)
  sourceDecodes = 0
  expect(replayJournal(old.database.db, 'chat')?.damage).toBeNull()
  expect(sourceDecodes).toBe(1)
  sourceDecodes = 0
  const units = vi.spyOn(JournalTextIndex.prototype, 'select')
  await r.journal.appendLifecycleBatch({
    settlementId: 'large',
    fence: 7,
    mutations: [
      {
        kind: 'item',
        identity: id,
        body: body('large-whole-tag'.repeat(1000)),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  await flushJournalTextIdle(r.journal)
  expect(sourceDecodes).toBe(units.mock.calls.length + 1)
  units.mockRestore()
  sourceDecodes = 0
  expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  expect(sourceDecodes).toBe(1)
  decoding.mockRestore()
  // Each case commits one inline unit, then faults its support before continuation.
  for (const corruption of ['missing', 'malformed', 'nested', 'external', 'rollback']) {
    const x = await rig(),
      stream = identity(corruption)
    await x.append(stream, 0)
    for (let k = 1; k <= 300; k++) {
      await x.append(stream, k)
    }
    await x.journal.appendLifecycleBatch({
      settlementId: 'whole',
      fence: 7,
      mutations: [
        {
          kind: 'item',
          identity: stream,
          body: body('a'.repeat(301)),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    const whole = x.rows().find((row) => row.kind === 'lifecycle-batch')
    if (!whole || whole.kind !== 'lifecycle-batch') {
      throw new Error('missing whole')
    }
    const remaining = x.rows().filter((row) => row.kind === 'text-delta').length
    const external =
      corruption === 'external' ? new Database(join(x.root, 'agent-session-journal.db')) : null
    const db = external ?? x.database.db
    if (corruption === 'rollback') {
      db.exec(
        "CREATE TEMP TRIGGER fail_retirement BEFORE DELETE ON journal_rows BEGIN SELECT RAISE(ABORT, 'retirement rollback'); END"
      )
    } else if (corruption === 'missing') {
      db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?').run(
        'chat',
        x.journal.epoch,
        whole.seq
      )
    } else {
      const json = JSON.stringify(whole)
      const changed =
        corruption === 'malformed'
          ? json.replace('"message"', '"invalid"')
          : JSON.stringify({
              ...whole,
              mutations: whole.mutations.map((mutation) => ({
                ...mutation,
                ...(corruption === 'nested' && mutation.kind === 'item'
                  ? { body: { ...mutation.body, skills: [{ name: 17, path: null }] } }
                  : { itemId: 'claude:s:wrong' })
              }))
            })
      db.prepare(
        'UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = ?'
      ).run(changed, 'chat', x.journal.epoch, whole.seq)
    }
    external?.close()
    await flushJournalTextIdle(x.journal)
    expect(
      [...iterateJournalEpochRows(x.database.db, 'chat', x.journal.epoch)].filter((row) =>
        row.rowJson.includes('"kind":"text-delta"')
      ).length
    ).toBe(remaining)
    if (corruption === 'rollback') {
      db.exec('DROP TRIGGER fail_retirement')
      await x.journal.appendItem(stream, body('a'.repeat(301)), options)
      await flushJournalTextIdle(x.journal)
      expect(x.rows().some((row) => row.kind === 'text-delta')).toBe(false)
      expect(replayJournal(db, 'chat')?.damage).toBeNull()
    }
  }
})

it('finalizes real Claude ingress before forgetting, and recovers only dead unwitnessed prose', async () => {
  for (const ending of ['exit', 'result', 'supersession']) {
    const r = await rig(),
      failures = vi.fn()
    const sink = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: failures, warn: vi.fn() },
      watermarks: { maxLifecycleQueuedOperations: 0 }
    })
    sink.bind({ journal: r.journal, fence: 7, publish: () => undefined })
    const transitions = sink.sink.tryAppendTransition && vi.spyOn(sink.sink, 'tryAppendTransition')
    const translator = createClaudeJournalTranslator({
      sink: sink.sink,
      schedule: () => () => undefined
    })
    const send = (message: Record<string, unknown>, startsTurn?: true) =>
      translator.handle({
        type: 'message',
        sessionId: 'chat',
        observedAt: 100,
        startsTurn,
        message
      })
    const frame = (event: Record<string, unknown>) =>
      send({ type: 'stream_event', uuid: 'frame', session_id: 's', event })
    frame({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } })
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let k = 0; k < 6; k++) {
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello ' }
      })
      translator.flush()
      expect((await sink.drained()).ok).toBe(true)
    }
    const endingScope = translator.currentTurnScope()
    if (endingScope.kind !== 'turn') {
      throw new Error('Missing ending turn identity')
    }
    if (ending === 'exit') {
      translator.handle({ type: 'ended', sessionId: 'chat', reason: 'exited', observedAt: 200 })
    } else if (ending === 'result') {
      send({
        type: 'result',
        subtype: 'success',
        session_id: 's',
        duration_ms: 100,
        is_error: false
      })
    } else {
      send(
        {
          type: 'user',
          uuid: 'u2',
          session_id: 's',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'next' }
        },
        true
      )
    }
    expect(translator.pendingStreamedBlocks).toBe(0)
    expect((await sink.drained()).ok).toBe(true)
    const wholes = r
      .rows()
      .filter(
        (row) => row.kind === 'item' && row.body.kind === 'message' && row.body.role === 'assistant'
      )
    expect(wholes.at(-1)).toMatchObject({ body: body('hello '.repeat(6)) })
    const turnEnd = r
      .rows()
      .findLast(
        (row) =>
          row.kind === 'item' &&
          row.body.kind === 'turn' &&
          (row.body.state === 'completed' || row.body.state === 'interrupted')
      )
    expect(wholes.at(-1)?.seq).toBeLessThan(turnEnd?.seq ?? 0)
    expect(r.rows().filter((row) => row.kind === 'text-delta')).toHaveLength(0)
    expect(r.journal.itemBody(endingScope.turnItemId)).toMatchObject({
      kind: 'turn',
      state: ending === 'result' ? 'completed' : 'interrupted'
    })
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
    expect(failures).not.toHaveBeenCalled()
    expect(transitions && transitions.mock.calls.some(([transition]) => transition.finalTail)).toBe(
      true
    )
    translator.dispose()
    await sink.drained()
    sink.close()
  }
  for (const size of [2, 300_000]) {
    const r = await rig(),
      id = identity(`dead-${size}`),
      key = agentJournalItemKey(id)
    await r.append(id, 0)
    await r.append(id, 1)
    if (size > 2) {
      await r.journal.appendItem(id, body(''), {
        ...options,
        streamText: {
          operation: 'append',
          field: 0,
          baseLength: 2,
          suffix: 'a'.repeat(size - 2)
        }
      })
    }
    await r.journal.close()
    const journal = await journals.open(r.settings)
    expect(journal.hasUnwitnessedText(key)).toBe(true)
    const input = {
      journal,
      sessionId: 'chat',
      fence: 8,
      acquisitionGeneration: 'dead',
      deathEvidence: null,
      below: 8
    }
    expect(planStaleStructuredAgentSessionState({ ...input, below: 7 }).mutations).toEqual([])
    const plan = planStructuredAgentSessionDeadGeneration(
      {
        journal,
        sessionId: 'chat',
        fence: 8,
        settlementId: 'exit',
        verdict: { state: 'interrupted', completedAt: 300 },
        pendingSubmissionReason: 'exited',
        showUnexpectedExitOutcome: false
      },
      (owner) => owner === 7
    )
    expect(plan.mutations).toHaveLength(1)
    const activity = journal.lastProviderActivityAt(7)
    await journal.appendLifecycleBatch({
      settlementId: 'dead',
      fence: 8,
      recovered: true,
      mutations: plan.mutations
    })
    expect(journal.hasUnwitnessedText(key)).toBe(false)
    expect(journal.lastProviderActivityAt(7)).toBe(activity)
    expect(planStaleStructuredAgentSessionState(input).mutations).toEqual([])
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  }
})

it('retains refused terminal text and joins no prefixes for unchanged attribution', async () => {
  let accept = true
  const writes = vi.fn(() => accept)
  const cp = createClaudeStreamedTextCheckpoints({
    producer: rootTextProducer,
    schedule: () => () => undefined,
    persist: writes,
    persistDelta: () => true
  })
  for (let k = 0; k < 20; k++) {
    cp.append(identity(`${k}`), 'large-prefix'.repeat(100))
    cp.flush()
  }
  const joins = vi.spyOn(Array.prototype, 'join')
  cp.reattribute()
  expect(joins).not.toHaveBeenCalled()
  expect(writes).not.toHaveBeenCalled()
  accept = false
  expect(cp.finish({ completedAt: 1 })).toBe(false)
  expect(cp.pending).toBe(20)
  accept = true
  expect(cp.finish({ completedAt: 1 })).toBe(true)
  expect(cp.pending).toBe(0)
  cp.dispose()
  const r = await rig()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: 'chat',
    logger: { error: vi.fn(), warn: vi.fn() }
  })
  const live = createClaudeStreamedTextCheckpoints({
    producer: rootTextProducer,
    schedule: () => () => undefined,
    source: deferred.sink.textSource,
    prepareText: deferred.sink.prepareText,
    persist: () => {
      throw new Error('whole fallback')
    },
    persistPrepared: (block, ended) =>
      deferred.sink.tryAppendTransition?.({
        steps: [block.step(body(''), options, ended !== undefined)],
        lifecycle: true,
        publish: true
      }).accepted === true,
    persistDelta: (id, window) => {
      const step = deferred.sink.prepareText?.(id, body(''), window, options)
      return (
        !!step &&
        deferred.sink.tryAppendTransition?.({
          steps: [step],
          lifecycle: false,
          publish: true
        }).accepted === true
      )
    }
  })
  live.append(identity('attribution'), 'a')
  live.reattribute()
  live.append(identity('attribution'), 'b')
  live.flush()
  expect(live.finish({ completedAt: 1 })).toBe(true)
  deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
  expect((await deferred.drained()).ok).toBe(true)
  expect(r.journal.itemBody(agentJournalItemKey(identity('attribution')))).toEqual(body('ab'))
  live.dispose()
  deferred.close()
})

it('replays sparse actual rows into exact and bounded client baselines without cleanup events', async () => {
  for (const boundedFrames of [false, true]) {
    const r = await rig(),
      id = identity('wire')
    const baselines = new Map<number, typeof EMPTY_STRUCTURED_AGENT_SESSION>()
    const capture = () => {
      let client = EMPTY_STRUCTURED_AGENT_SESSION
      const registry = new AgentSessionSubscribers()
      registry.open({
        id: 'baseline',
        sessionId: 'chat',
        journal: r.journal,
        fence: 7,
        boundedFrames,
        emit: (event) => {
          client = reduceStructuredAgentSession(client, { type: 'event', event })
        }
      })
      baselines.set(r.journal.cursor().sequence, client)
    }
    capture() // epoch=1
    await r.append(id, 0) // A=2
    await r.append(id, 1) // D=3
    capture()
    await r.journal.appendItem(identity('control'), { kind: 'status', text: 'control' }, options) // Q=4
    await r.append(id, 2) // E=5
    capture()
    await r.journal.appendItem(id, body('authoritative'), options) // W=6
    capture()
    await r.journal.appendItem(
      identity('unrelated'),
      { kind: 'status', text: 'unrelated' },
      options
    ) // U=7
    capture()
    await flushJournalTextIdle(r.journal)
    expect(r.rows().map((row) => row.seq)).toEqual([1, 2, 4, 6, 7])
    for (const [sequence, baseline] of baselines) {
      let client = baseline
      const events: AgentSessionSubscribeEvent[] = []
      const registry = new AgentSessionSubscribers()
      registry.open({
        id: `after-${sequence}`,
        sessionId: 'chat',
        journal: r.journal,
        fence: 7,
        cursor: { epoch: r.journal.epoch, sequence },
        snapshotCatchUp: false,
        boundedFrames,
        emit: (event) => {
          events.push(event)
          client = reduceStructuredAgentSession(client, { type: 'event', event })
        }
      })
      expect(client.cursor).toEqual(r.journal.cursor())
      expect(client.items).toEqual(
        r.journal
          .snapshot()
          .items.map((item) => subscriberHistoryReader({ boundedFrames }).form(item).item)
      )
      expect(events.some((event) => event.type === 'reset')).toBe(false)
      if (sequence >= 6) {
        expect(
          events
            .flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
            .some((item) => item.itemId === agentJournalItemKey(id))
        ).toBe(false)
      }
      const page = readAgentSessionHistory(r.journal, {
        sessionId: 'chat',
        direction: 'after',
        cursor: { epoch: r.journal.epoch, sequence },
        limit: 1
      })
      expect(page.ok).toBe(true)
      registry.open({
        id: 'failed',
        sessionId: 'chat',
        journal: r.journal,
        fence: 7,
        cursor: { epoch: r.journal.epoch, sequence: 1 },
        snapshotCatchUp: false,
        emit: () => {
          throw new Error('closed transport')
        }
      })
      expect(registry.subscriberCountForTests('chat')).toBe(1)
    }
    for (let index = 0; index < 201; index++) {
      await r.journal.appendItem(
        identity(`page-${index}`),
        { kind: 'status', text: `page ${index}` },
        options
      )
    }
    let client = baselines.get(1)!
    const queue = { queuedMessages: [], queuePause: null, nextQueuedMessageId: null }
    const registry = new AgentSessionSubscribers({ readQueuePublication: () => queue })
    const frames: AgentSessionSubscribeEvent[] = []
    registry.open({
      id: 'partial',
      sessionId: 'chat',
      journal: r.journal,
      fence: 7,
      cursor: client.cursor!,
      snapshotCatchUp: false,
      boundedFrames,
      emit: (event) => {
        if (frames.length === 1) {
          throw new Error('partial transport')
        }
        frames.push(event)
        client = reduceStructuredAgentSession(client, { type: 'event', event })
      }
    })
    expect(registry.subscriberCountForTests('chat')).toBe(0)
    expect(frames[0]).not.toHaveProperty('queuedMessages')
    const replayed: AgentSessionSubscribeEvent[] = []
    registry.open({
      id: 'retry',
      sessionId: 'chat',
      journal: r.journal,
      fence: 7,
      cursor: client.cursor!,
      snapshotCatchUp: false,
      boundedFrames,
      emit: (event) => {
        replayed.push(event)
        client = reduceStructuredAgentSession(client, { type: 'event', event })
      }
    })
    expect(client.cursor).toEqual(r.journal.cursor())
    expect(replayed.at(-1)).toHaveProperty('queuedMessages', [])
    expect(replayed.slice(0, -1).every((event) => !('queuedMessages' in event))).toBe(true)
    await r.journal.appendItem(id, body('later correction'), options)
    registry.publish('chat', r.journal)
    expect(client.items.find((item) => item.itemId === agentJournalItemKey(id))?.body).toEqual(
      body('later correction')
    )
    const beforeActivity = client.cursor
    registry.publish('chat', r.journal, { turnId: 'activity', text: 'working' })
    expect(client.cursor).toEqual(beforeActivity)
    expect(replayed.at(-1)).toMatchObject({ type: 'batch', activity: { text: 'working' } })
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  }
})

it('terminalizes 257 real-shaped prose/thinking blocks and preserves evicted returns with deferred writes', async () => {
  for (const kind of ['text', 'thinking']) {
    const r = await rig(),
      failures = vi.fn()
    const sink = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: failures, warn: vi.fn() }
    })
    sink.bind({ journal: r.journal, fence: 7, publish: () => undefined })
    const translator = createClaudeJournalTranslator({
      sink: sink.sink,
      schedule: () => () => undefined
    })
    const frame = (uuid: string, event: Record<string, unknown>) =>
      translator.handle({
        type: 'message',
        sessionId: 'chat',
        observedAt: 100,
        message: { type: 'stream_event', session_id: 's', uuid, parent_tool_use_id: null, event }
      })
    frame('start', {
      type: 'message_start',
      message: { id: 'message', role: 'assistant', content: [] }
    })
    for (let index = 0; index < 257; index++) {
      frame(`block-${index}`, {
        type: 'content_block_start',
        index,
        content_block: { type: kind, [kind]: '' }
      })
      for (const text of ['a', 'b']) {
        frame(`delta-${index}-${text}`, {
          type: 'content_block_delta',
          index,
          delta: { type: `${kind}_delta`, [kind]: text }
        })
        translator.flush()
      }
    }
    frame('return', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: `${kind}_delta`, [kind]: 'c' }
    })
    translator.flush()
    if (kind === 'thinking') {
      translator.handle({
        type: 'message',
        sessionId: 'chat',
        observedAt: 150,
        message: {
          type: 'assistant',
          uuid: 'message',
          session_id: 's',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }
        }
      })
      expect(translator.pendingStreamedBlocks).toBe(256)
    }
    translator.handle({ type: 'ended', sessionId: 'chat', reason: 'exited', observedAt: 200 })
    expect(translator.pendingStreamedBlocks).toBe(0)
    expect((await sink.drained()).ok).toBe(true)
    const item = r.journal.item(
      agentJournalItemKey({ provider: 'claude', sessionId: 's', uuid: 'block:message:0' })
    )
    expect(item?.body).toMatchObject({
      kind: 'message',
      blocks: [{ type: 'text', text: 'abc' }]
    })
    if (kind === 'thinking') {
      expect(item?.body).toMatchObject({ role: 'reasoning', state: 'completed' })
    }
    expect(failures).not.toHaveBeenCalled()
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
    translator.dispose()
    sink.close()
  }
})

it('keeps real Codex live identities through cache and ordinal-byte eviction, then finishes delta-only fields', async () => {
  const r = await rig(),
    failures = vi.fn()
  const allocate = vi.spyOn(CodexTurnOrdinals.prototype, 'ordinalFor')
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: 'chat',
    logger: { error: failures, warn: vi.fn() }
  })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    schedule: () => () => undefined,
    primaryThreadId: () => 'thread'
  })
  const send = (method: string, params: unknown) =>
    expect(
      translator.handle({
        type: 'notification',
        sessionId: 'chat',
        threadId: 'thread',
        method,
        params
      }).accepted
    ).toBe(true)
  const raw = (n: number) => `${n}-${'x'.repeat(1100)}`
  const delta = (n: number, text: string) => {
    send('item/agentMessage/delta', { itemId: raw(n), turnId: 'turn', delta: text })
    translator.flush()
  }
  send('turn/started', { turn: { id: 'turn' } })
  for (let n = 0; n < 550; n++) {
    delta(n, 'a')
  }
  const key = codexLiveTextKey('thread', 'turn', { type: 'agentMessage', id: raw(0) })
  const original = deferred.sink.liveText?.(key)?.live?.identity
  expect(original).toMatchObject({
    provider: 'codex',
    threadId: 'thread',
    turnId: 'turn',
    ordinal: 0
  })
  delta(0, 'b')
  expect(deferred.sink.liveText?.(key)?.live?.identity).toEqual(original)
  expect(deferred.sink.journalItems?.()).toBeNull()
  deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
  expect((await deferred.drained()).ok).toBe(true)
  if (!original) {
    throw new Error('missing admitted live identity')
  }
  expect(r.journal.itemBody(agentJournalItemKey(original))).toEqual(body('ab'))
  for (let n = 550; n < 2200; n++) {
    delta(n, 'a')
    if (n % 128 === 0) {
      expect((await deferred.drained()).ok).toBe(true)
    }
  }
  expect((await deferred.drained()).ok).toBe(true)
  const allocations = allocate.mock.calls.length
  const ordinalOwner = allocate.mock.contexts[0]
  assert.instanceOf(ordinalOwner, CodexTurnOrdinals)
  expect(ordinalOwner.bytes).toBeLessThanOrEqual(512 * 1024)
  delta(0, 'c')
  expect(allocate.mock.calls).toHaveLength(allocations)
  expect((await deferred.drained()).ok).toBe(true)
  expect(r.journal.itemBody(agentJournalItemKey(original))).toEqual(body('abc'))
  send('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  expect((await deferred.drained()).ok).toBe(true)
  expect(deferred.sink.liveTexts?.()).toEqual([])
  const rows = r.rows()
  const terminal = rows.findLast(
    (row) => row.kind === 'lifecycle-batch' || (row.kind === 'item' && row.body.kind === 'turn')
  )
  const wholes = rows.filter((row) => row.kind === 'item' && row.body.kind === 'message')
  expect(wholes).toHaveLength(4401)
  expect(wholes.at(-1)!.seq).toBeLessThan(terminal!.seq)
  expect(r.journal.snapshot().items.filter((item) => item.body.kind === 'message')).toHaveLength(
    2200
  )
  await flushJournalTextIdle(r.journal)
  const loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.items.get(agentJournalItemKey(original))?.body).toEqual(body('abc'))
  delta(0, 'late')
  expect((await deferred.drained()).ok).toBe(true)
  expect(deferred.sink.liveText?.(key)?.live?.identity).not.toEqual(original)
  expect(r.journal.itemBody(agentJournalItemKey(original))).toEqual(body('abc'))
  expect(failures).not.toHaveBeenCalled()
  translator.dispose()
  deferred.close()
})
