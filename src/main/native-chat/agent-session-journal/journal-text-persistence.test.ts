import { vi, afterEach, expect, it } from 'vitest'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { createAgentSessionDeltaCoalescer } from '../agent-session-wire/agent-session-delta-coalescer'
import { appendStructuredAgentSessionTextWindow } from '../agent-session-wire/structured-agent-session-text-append'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { replayJournal } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  rootTextProducer,
  textJournals as journals,
  closeTextJournals,
  textRig as rig,
  textIdentity as identity,
  textIdentityOf as identityOf,
  textBody as body,
  textOptions as options
} from './journal-text-test-support'
const itemId = agentJournalItemKey(identity)
afterEach(closeTextJournals)

it('saves only increments, reopens an interrupted stream, and catches up through sparse rows', async () => {
  const r = await rig()
  await r.stream(0, 'hello', 'hello')
  r.time(200)
  await r.stream(5, ' world', 'hello world')
  const delta = r.rows().find((row) => row.kind === 'text-delta')
  expect(delta).toMatchObject({
    v: 5,
    suffix: ' world',
    baseLength: 5,
    predecessor: 1,
    revision: 2
  })
  expect(delta).not.toHaveProperty('body')
  expect(replayJournal(r.database.db, 'chat')?.state.items.get(itemId)?.body).toEqual(
    body('hello world')
  )
  const user = { ...body('next'), role: 'user' as const }
  await r.journal.queuedMessages.insert({ messageId: 'queued', body: user })
  await r.journal.appendSubmission({
    clientMessageId: 'owed',
    payloadFingerprint: 'fingerprint',
    body: user,
    fence: 7
  })
  await r.journal.resolveDispatch({
    clientMessageId: 'owed',
    fence: 7,
    state: 'unknown',
    reason: 'unconfirmed'
  })
  const control: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'control' }
  await r.journal.appendItem(
    control,
    {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    options
  )
  const before = r.journal.item(itemId)
  if (!before) {
    throw new Error('missing item')
  }
  await r.journal.close()
  const reopened = await journals.open(r.settings)
  expect(reopened.item(itemId)).toEqual(before)
  r.time(300)
  await reopened.appendItem(identity, body('CORRECTED'), options)
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
  const loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.state.items.get(agentJournalItemKey(control))?.body.kind).toBe('approval')
  expect(loaded?.state.queue.cards.get('queued')?.body.blocks).toEqual([
    { type: 'text', text: 'next' }
  ])
  expect(loaded?.state.submissions.get('owed')?.dispatchState).toBe('unknown')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.items.get(itemId)).toMatchObject({
    sequence: before.sequence,
    observedAt: before.observedAt,
    body: body('CORRECTED')
  })
  expect(reopened.readSince({ epoch: reopened.epoch, sequence: before.sequence }).ok).toBe(true)
  // The format whole is still required in the strict prefix.
  r.database.db
    .prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
    .run('chat', reopened.epoch, before.sequence)
  expect(replayJournal(r.database.db, 'chat')?.damage).toMatchObject({ cause: 'sequence-gap' })
})

it('retains the last real activity observation under a recovered or different-owner whole', async () => {
  const r = await rig()
  await r.stream(0, 'a', 'a')
  r.time(200)
  await r.stream(1, 'b', 'ab')
  const piece = r.rows().find((row) => row.kind === 'text-delta')
  r.time(300)
  await r.journal.appendItem(identity, body('ab'), { ...options, recovered: true })
  expect(r.rows()).toContainEqual(piece)
  let loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.damage).toBeNull()
  expect(loaded?.state.providerActivityAt.get(7)).toBe(200)
  r.time(350)
  await r.journal.appendItem(identity, body('ab'), { ...options, executionOwner: 8 })
  loaded = replayJournal(r.database.db, 'chat')
  expect(loaded?.state.providerActivityAt.get(7)).toBe(200)
  expect(r.rows()).toContainEqual(piece)
  r.time(400)
  await r.journal.appendItem(identity, body('ab'), { ...options, executionOwner: 7 })
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
  expect(replayJournal(r.database.db, 'chat')?.state.providerActivityAt.get(7)).toBe(400)
})

it('replays partial pruning across surviving superseded pieces without inventing predecessors', async () => {
  const r = await rig()
  await r.stream(0, 'a', 'a')
  await r.stream(1, 'b', 'ab')
  const anchor = r.rows().find((row) => row.kind === 'item')
  const delta = r.rows().find((row) => row.kind === 'text-delta')
  if (!anchor || !delta) {
    throw new Error('missing source rows')
  }
  const state = createJournalReducerState('chat', r.journal.epoch)
  state.replayTextDebt = new Map()
  applyJournalRow(state, anchor)
  const piece = { ...delta, seq: 4, predecessor: 2, revision: 3, baseLength: 2, suffix: 'c' }
  applyJournalRow(state, piece)
  applyJournalRow(state, { ...anchor, seq: 6, revision: 5, body: body('corrected') })
  expect(state.items.get(itemId)?.body).toEqual(body('corrected'))
  expect(state.replayTextDebt?.size).toBe(0)
  for (const seq of [8, 9]) {
    applyJournalRow(state, {
      ...piece,
      seq,
      predecessor: 5,
      revision: 6,
      baseLength: 9,
      suffix: '!'
    })
  }
  expect(state.items.get(itemId)?.body).toEqual(body('corrected!'))
  state.replayTextDebt = null
  expect(() => applyJournalRow(state, { ...piece, seq: 10, revision: 7 })).toThrow(
    'journal_text_predecessor_missing'
  )
})

it('owns deferred source through conditional null/winning wholes, refusal, finish and same-live reopen', async () => {
  for (const winning of [false, true]) {
    const r = await rig(),
      errors = vi.fn(),
      publication = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: errors, warn: vi.fn() },
      watermarks: { maxQueuedOperations: winning ? 3 : 4 }
    })
    const sink = deferred.sink
    if (!winning) {
      expect(sink.tryAppendItem?.(identity, body('seed'), options).accepted).toBe(true)
    }
    const coalescer = createAgentSessionDeltaCoalescer({
      source: () => sink.textSource?.(identity),
      emit: () => {
        throw new Error('whole fallback')
      },
      schedule: () => () => undefined,
      emitDelta: (_, window) =>
        appendStructuredAgentSessionTextWindow(sink, identity, body(''), window, options)
    })
    coalescer.append(itemId, 'a')
    expect(coalescer.flushAll()).toBe(true)
    const authoritative = '"\n😀'.repeat(100)
    const before = sink.textSource?.(identity)
    expect(before?.length).toBe(1)
    expect(
      sink.tryReviseResolvedItem?.(
        10_000,
        () => (winning ? { identity, body: body(authoritative) } : null),
        options
      ).accepted
    ).toBe(true)
    coalescer.append(itemId, 'b')
    expect(coalescer.flushAll()).toBe(true)
    coalescer.append(itemId, 'c')
    expect(coalescer.flushAll()).toBe(false)
    deferred.bind({ journal: r.journal, fence: 7, publish: publication })
    expect((await deferred.drained()).ok).toBe(true)
    expect(coalescer.flushAll()).toBe(true)
    expect((await deferred.drained()).ok).toBe(true)
    const text = `${winning ? authoritative : 'seeda'}bc`
    expect(r.journal.itemBody(itemId)).toEqual(body(text))
    expect(r.journal.textSource(itemId)).toMatchObject({
      length: text.length,
      encodedBytes: Buffer.byteLength(JSON.stringify(text)) - 2
    })
    const policy = r.journal.textSource(itemId)
    await r.journal.open()
    expect(r.journal.textSource(itemId)).toBe(policy)
    const finish = sink.prepareText?.(
      identity,
      body(''),
      { baseLength: 0, suffix: '' },
      {
        ...options,
        streamText: { operation: 'finish', field: 0, baseLength: 0, suffix: '' }
      }
    )
    if (!finish) {
      throw new Error('missing finish')
    }
    expect(
      sink.tryAppendTransition?.({ steps: [finish], lifecycle: true, publish: true }).accepted
    ).toBe(true)
    coalescer.forget(itemId)
    expect((await deferred.drained()).ok).toBe(true)
    expect(sink.textSource?.(identity)).toBeUndefined()
    expect(r.journal.itemBody(itemId)).toEqual(body(text))
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    expect(publication).toHaveBeenCalled()
    coalescer.dispose()
    deferred.close()
  }
})

it('matches independent chunk cuts and retains only the current resident generation credit', async () => {
  const { AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER: marker } =
    await import('../agent-session-wire/agent-session-streamed-text-bounds')
  for (const chunks of [
    ['\ud83d', '\ude00', 'A', '😀'],
    ['😀', 'A', '\ud83d', '\ude00']
  ]) {
    const r = await rig(),
      errors = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: errors, warn: vi.fn() }
    })
    deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
    let expected = ''
    const baseline = createAgentSessionDeltaCoalescer({
      emit: (_, text) => {
        expected = text
      },
      maxRetainedBytes: Buffer.byteLength(marker) + 5,
      schedule: () => () => undefined
    })
    const live = createAgentSessionDeltaCoalescer({
      emit: () => false,
      source: () => deferred.sink.textSource?.(identity),
      maxRetainedBytes: Buffer.byteLength(marker) + 5,
      emitDelta: (_, window) =>
        appendStructuredAgentSessionTextWindow(deferred.sink, identity, body(''), window, options),
      schedule: () => () => undefined
    })
    for (const chunk of [...chunks, 'overflow'.repeat(20), 'ignored']) {
      baseline.append(itemId, chunk)
      baseline.flushAll()
      live.append(itemId, chunk)
      live.flushAll()
      expect((await deferred.drained()).ok).toBe(true)
    }
    expect(r.journal.itemBody(itemId)).toEqual(body(expected))
    expect(r.journal.textSource(itemId)?.truncated).toBe(true)
    expect(errors).not.toHaveBeenCalled()
    baseline.dispose()
    live.dispose()
    deferred.close()
  }
})

it('credits flushed resident bytes until forget and does not recharge a returning canonical prefix', async () => {
  const r = await rig(),
    errors = vi.fn()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: 'chat',
    logger: { error: errors, warn: vi.fn() }
  })
  deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
  const coalescer = createAgentSessionDeltaCoalescer({
    source: (key) => deferred.sink.textSource?.(identityOf(key)),
    maxTotalRetainedBytes: 40,
    maxRetainedBytes: 40,
    maxStreams: 3,
    schedule: () => () => undefined,
    emit: () => false,
    emitDelta: (key, window) =>
      appendStructuredAgentSessionTextWindow(
        deferred.sink,
        identityOf(key),
        body(''),
        window,
        options
      )
  })
  const append = async (key: string, text: string) => {
    expect(coalescer.append(key, text)).toBe(true)
    expect(coalescer.flushAll()).toBe(true)
    expect((await deferred.drained()).ok).toBe(true)
  }
  const saved = (key: string) => r.journal.itemBody(agentJournalItemKey(identityOf(key)))
  await append('a', 'a'.repeat(20))
  await append('b', 'b'.repeat(30))
  expect(saved('b')).toEqual(body('\n[Orca: streamed out'))
  coalescer.forget('a')
  await append('a', 'a'.repeat(10))
  expect(saved('a')).toEqual(body('a'.repeat(30)))
  await append('c', 'c'.repeat(20))
  expect(saved('c')).toEqual(body('\n[Orca: st'))
  coalescer.forget('b')
  await append('d', 'd'.repeat(20))
  expect(saved('d')).toEqual(body('d'.repeat(20)))
  await append('b', 'ignored')
  expect(saved('b')).toEqual(body('\n[Orca: streamed out'))
  const head = r.journal.cursor()
  expect(
    deferred.sink.tryAppendStreamedItem?.(identityOf('b'), body(''), {
      ...options,
      streamText: { operation: 'append', field: 0, baseLength: 0, suffix: 'superseded' }
    }).accepted
  ).toBe(true)
  expect((await deferred.drained()).ok).toBe(true)
  expect(r.journal.cursor()).toEqual(head)
  expect(deferred.state().queuedOperations).toBe(0)
  expect(errors).not.toHaveBeenCalled()
  coalescer.dispose()
  deferred.close()
})

it('preserves skipped whitespace through real provider ingress, unsupplied completion and reopen', async () => {
  const { createClaudeJournalTranslator } =
    await import('../../claude/claude-structured-journal-translation')
  const { createCodexJournalTranslator } =
    await import('../../codex/codex-structured-journal-translation')
  const { openProviderTimelineRig, closeProviderTimelineRigs, messageText, providerItemId } =
    await import('../agent-session-timeline/provider-timeline-assembler-test-support')
  try {
    for (const chunks of [
      ['    ', 'code'],
      ['code', '   '],
      ['  ', '  ']
    ]) {
      const expected = chunks.join('')
      for (const provider of ['claude', 'codex', 'timeline']) {
        if (provider === 'timeline') {
          const r = await openProviderTimelineRig({ schedule: () => () => undefined })
          for (const text of chunks) {
            expect(
              r.assembler.apply({
                type: 'text.delta',
                item: { id: 'm' },
                channel: 'assistant',
                text
              }).admission.accepted
            ).toBe(true)
            r.assembler.flush()
            await r.rows()
          }
          const key = providerItemId('item', 'm')
          expect(messageText((await r.row(key))?.body)).toBe(expected.trim() ? expected : undefined)
          expect(
            r.assembler.apply({ type: 'text.close', item: { id: 'm' } }).admission.accepted
          ).toBe(true)
          const reopened = await r.reopenJournal()
          expect(messageText(reopened.itemBody(key) ?? undefined)).toBe(
            expected.trim() ? expected : undefined
          )
          continue
        }
        const r = await rig(),
          errors = vi.fn()
        const deferred = createDeferredStructuredAgentSessionEventSink({
          sessionId: 'chat',
          logger: { error: errors, warn: vi.fn() }
        })
        deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
        const claude = createClaudeJournalTranslator({
          sink: deferred.sink,
          schedule: () => () => undefined
        })
        const codex = createCodexJournalTranslator({
          sink: deferred.sink,
          schedule: () => () => undefined,
          primaryThreadId: () => 'thread'
        })
        const frame = (event: unknown) =>
          claude.handle({
            type: 'message',
            sessionId: 'chat',
            observedAt: 100,
            message: { type: 'stream_event', session_id: 's', uuid: 'frame', event }
          })
        const notify = (method: string, params: unknown) =>
          expect(
            codex.handle({
              type: 'notification',
              sessionId: 'chat',
              threadId: 'thread',
              method,
              params
            }).accepted
          ).toBe(true)
        if (provider === 'claude') {
          frame({ type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } })
          frame({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' }
          })
        } else {
          notify('turn/started', { turn: { id: 'turn' } })
        }
        for (const delta of chunks) {
          if (provider === 'claude') {
            frame({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: delta }
            })
            claude.flush()
          } else {
            notify('item/reasoning/textDelta', { itemId: 'r', turnId: 'turn', delta })
            codex.flush()
          }
          expect((await deferred.drained()).ok).toBe(true)
        }
        const messages = () =>
          r.journal.snapshot().items.filter((item) => item.body.kind === 'message')
        // No authoritative final has had an opportunity to repair this value.
        expect(
          messages().map((item) => (item.body.kind === 'message' ? item.body.blocks : []))
        ).toEqual(expected.trim() ? [[{ type: 'text', text: expected }]] : [])
        if (provider === 'claude') {
          claude.handle({ type: 'ended', sessionId: 'chat', reason: 'exited', observedAt: 200 })
        } else {
          notify('item/completed', {
            turnId: 'turn',
            item: { id: 'r', type: 'reasoning', text: [], summary: [] }
          })
        }
        expect((await deferred.drained()).ok).toBe(true)
        const final = messages()
        expect(final.map((item) => (item.body.kind === 'message' ? item.body.blocks : []))).toEqual(
          expected.trim() ? [[{ type: 'text', text: expected }]] : []
        )
        await r.journal.close()
        const reopened = await journals.open(r.settings)
        expect(reopened.snapshot().items.filter((item) => item.body.kind === 'message')).toEqual(
          final
        )
        expect(errors).not.toHaveBeenCalled()
        claude.dispose()
        codex.dispose()
        deferred.close()
      }
    }
  } finally {
    await closeProviderTimelineRigs()
  }
})

it('keeps skipped and refused suffix ownership through unbound start and completion', async () => {
  const r = await rig(),
    errors = vi.fn()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: 'chat',
    logger: { error: errors, warn: vi.fn() },
    watermarks: { maxQueuedOperations: 1 }
  })
  const sink = deferred.sink
  expect(sink.tryAppendItem?.(identityOf('blocker'), body('blocker'), options).accepted).toBe(true)
  const stream = createAgentSessionDeltaCoalescer({
    source: () => sink.textSource?.(identity),
    schedule: () => () => undefined,
    emit: () => false,
    emitDelta: (_, window) =>
      !window.hasText ||
      appendStructuredAgentSessionTextWindow(sink, identity, body(''), window, options)
  })
  stream.append(itemId, '    ')
  expect(stream.flushAll()).toBe(true)
  expect(sink.textSource?.(identity)).toBeUndefined()
  stream.append(itemId, 'code')
  expect(stream.flushAll()).toBe(false)
  expect(stream.window(itemId)?.suffix).toBe('    code')
  deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
  expect((await deferred.drained()).ok).toBe(true)
  deferred.unbind()
  expect(stream.flushAll()).toBe(true)
  expect(sink.textSource?.(identity)?.length).toBe(8)
  expect(stream.window(itemId)?.suffix).toBe('')
  const finish = sink.prepareText?.(
    identity,
    body(''),
    { baseLength: 8, suffix: '' },
    { ...options, streamText: { operation: 'finish', field: 0, baseLength: 8, suffix: '' } }
  )
  if (!finish) {
    throw new Error('missing finish')
  }
  expect(
    sink.tryAppendTransition?.({ steps: [finish], lifecycle: true, publish: true, finalTail: true })
      .accepted
  ).toBe(true)
  stream.forget(itemId)
  deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
  expect((await deferred.drained()).ok).toBe(true)
  expect(r.journal.itemBody(itemId)).toEqual(body('    code'))
  expect(r.rows().filter((row) => row.kind === 'item' && row.itemId === itemId)).toHaveLength(2)
  expect(sink.textSource?.(identity)).toBeUndefined()
  expect(replayJournal(r.database.db, 'chat')?.state.items.get(itemId)?.body).toEqual(
    body('    code')
  )
  expect(errors).not.toHaveBeenCalled()
  stream.dispose()
  deferred.close()
})

it('finishes selected Codex reasoning by raw key at N and 10N without enumerating siblings', async () => {
  const { createCodexJournalTranslator } =
    await import('../../codex/codex-structured-journal-translation')
  const { codexLiveTextKey } = await import('../../codex/codex-thread-item-identity')
  const { CodexItemStreamRetention } = await import('../../codex/codex-item-stream-retention')
  for (const n of [30, 300]) {
    const r = await rig(),
      errors = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: errors, warn: vi.fn() }
    })
    deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
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
    send('turn/started', { turn: { id: 'turn' } })
    for (let k = 0; k < n; k++) {
      send('item/started', {
        turnId: 'turn',
        item: {
          type: 'commandExecution',
          id: `cmd-${k}`,
          source: 'unifiedExecStartup',
          command: 'sleep 30',
          cwd: '/workspace',
          status: 'inProgress'
        }
      })
      expect((await deferred.drained()).ok).toBe(true)
    }
    for (let k = 0; k <= n; k++) {
      send('item/reasoning/textDelta', { itemId: `r-${k}`, turnId: 'turn', delta: `reason-${k}` })
      translator.flush()
      expect((await deferred.drained()).ok).toBe(true)
    }
    const general = vi.spyOn(deferred.sink, 'liveTexts')
    const keyed = vi.spyOn(deferred.sink, 'liveText')
    let productionLookups = 0
    let commandVisits = 0
    const originalGet = CodexItemStreamRetention.prototype.get
    const get = vi.spyOn(CodexItemStreamRetention.prototype, 'get').mockImplementation(function (
      this: InstanceType<typeof CodexItemStreamRetention>,
      key
    ) {
      if (key.includes('cmd-')) {
        commandVisits++
      }
      return originalGet.call(this, key)
    })
    for (let k = 0; k < n; k++) {
      const raw = codexLiveTextKey('thread', 'turn', { type: 'reasoning', id: `r-${k}` })
      const identity = deferred.sink.liveText?.(raw)?.live?.identity
      expect(identity).toBeDefined()
      const beforeCompletion = keyed.mock.calls.length
      send('item/completed', {
        turnId: 'turn',
        item: { id: `r-${k}`, type: 'reasoning', text: [], summary: [] }
      })
      expect((await deferred.drained()).ok).toBe(true)
      productionLookups += keyed.mock.calls.length - beforeCompletion
      if (!identity) {
        throw new Error('missing selected identity')
      }
      expect(r.journal.itemBody(agentJournalItemKey(identity))).toMatchObject({
        role: 'reasoning',
        blocks: [{ type: 'text', text: `reason-${k}` }],
        state: 'completed'
      })
      expect(deferred.sink.liveText?.(raw)).toBeUndefined()
    }
    get.mockRestore()
    expect(commandVisits).toBe(0)
    expect(
      r.journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    ).toHaveLength(n)
    expect(general).not.toHaveBeenCalled()
    expect(productionLookups).toBeLessThanOrEqual(3 * n)
    console.info('selected Codex completion operations', {
      n,
      generalCalls: general.mock.calls.length,
      generalPopulationVisits: 0,
      commandVisits,
      productionLookups,
      keyedLookupsIncludingTestProbes: keyed.mock.calls.length
    })
    expect(
      deferred.sink.liveText?.(
        codexLiveTextKey('thread', 'turn', { type: 'reasoning', id: `r-${n}` })
      )?.live?.body
    ).toMatchObject({ state: 'running' })
    expect(errors).not.toHaveBeenCalled()
    translator.dispose()
    deferred.close()
  }
})

it('selects pending Codex completion by thread, turn, type and live/history namespace before bind', async () => {
  const { createCodexJournalTranslator } =
    await import('../../codex/codex-structured-journal-translation')
  const { codexLiveTextKey } = await import('../../codex/codex-thread-item-identity')
  const { journalReasoningBody } = await import('./journal-reasoning-row')
  for (const historyImport of [undefined, true] as const) {
    const r = await rig(),
      errors = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: errors, warn: vi.fn() }
    })
    const variants = [
      ['thread', 'turn', 'reasoning', historyImport],
      ['sibling-thread', 'turn', 'reasoning', historyImport],
      ['thread', 'sibling-turn', 'reasoning', historyImport],
      ['thread', 'turn', 'agentMessage', historyImport],
      ['thread', 'turn', 'reasoning', historyImport ? undefined : true]
    ] as const
    const sources = variants.map(([thread, turn, type, namespace], k) => {
      const raw = codexLiveTextKey(thread, turn, { type, id: 'same-id' }, namespace)
      const id = identityOf(`collision-${k}`)
      const reasoning = journalReasoningBody('x', { state: 'running' })
      if (!reasoning) {
        throw new Error('missing reasoning body')
      }
      expect(
        deferred.sink.tryAppendStreamedItem?.(id, reasoning, {
          ...options,
          rawTextKey: raw,
          streamText: { operation: 'start', field: 0, baseLength: 0, suffix: `text-${k}` }
        }).accepted
      ).toBe(true)
      expect(deferred.sink.liveText?.(raw)?.live?.identity).toEqual(id)
      return { raw, id }
    })
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      historyImport,
      schedule: () => () => undefined
    })
    const general = vi.spyOn(deferred.sink, 'liveTexts')
    expect(
      translator.handle({
        type: 'notification',
        sessionId: 'chat',
        threadId: 'thread',
        method: 'item/completed',
        params: {
          turnId: 'turn',
          item: { type: 'reasoning', id: 'same-id', text: [], summary: [] }
        }
      }).accepted
    ).toBe(true)
    expect(general).not.toHaveBeenCalled()
    deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
    expect((await deferred.drained()).ok).toBe(true)
    for (const [k, source] of sources.entries()) {
      expect(r.journal.itemBody(agentJournalItemKey(source.id))).toMatchObject({
        blocks: [{ type: 'text', text: `text-${k}` }],
        state: k === 0 ? 'completed' : 'running'
      })
      expect(deferred.sink.liveText?.(source.raw) !== undefined).toBe(k !== 0)
    }
    expect(errors).not.toHaveBeenCalled()
    translator.dispose()
    deferred.close()
  }
})

it('materializes a cold Claude whole only for its fallback consumer, allowing suffix assembly', async () => {
  const { createClaudeStreamedTextCheckpoints } =
    await import('../../claude/claude-streamed-text-checkpoints')
  for (const prepared of [true, false]) {
    const r = await rig(),
      errors = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: errors, warn: vi.fn() }
    })
    const cp = createClaudeStreamedTextCheckpoints({
      ...(prepared
        ? { source: deferred.sink.textSource, prepareText: deferred.sink.prepareText }
        : {}),
      schedule: () => () => undefined,
      producer: rootTextProducer,
      persist: () => true
    })
    const chunk = 'COLD-JOIN'.repeat(8192)
    cp.append(identity, chunk)
    const original = Array.prototype.join
    let assemblies = 0
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator
    ) {
      if (this[0] === chunk) {
        assemblies++
      }
      return original.call(this, separator)
    })
    let steps
    try {
      const blocks = cp.prepareFinish()
      expect(assemblies).toBe(1)
      expect(blocks[0].hasText).toBe(true)
      steps = [blocks[0].step(body(''), options)]
      if (prepared) {
        expect(assemblies).toBe(1)
      } else {
        expect(assemblies).toBeGreaterThan(1)
      }
    } finally {
      spy.mockRestore()
    }
    expect(
      deferred.sink.tryAppendTransition?.({ steps, lifecycle: true, publish: true }).accepted
    ).toBe(true)
    deferred.bind({ journal: r.journal, fence: 7, publish: () => undefined })
    expect((await deferred.drained()).ok).toBe(true)
    expect(r.journal.itemBody(itemId)).toEqual(body(chunk))
    expect(errors).not.toHaveBeenCalled()
    cp.dispose()
    deferred.close()
  }
})
