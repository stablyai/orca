import { afterEach, expect, it, vi } from 'vitest'
import { checkpointJournalRig, closeCheckpointTestJournals } from './claude-checkpoint-test-support'
afterEach(closeCheckpointTestJournals)

it.each([
  { count: 257, textless: false },
  { count: 257, textless: true },
  { count: 629, textless: false }
])(
  'completes $count published reasoning blocks, textless final=$textless, through idle and reopen',
  async ({ count, textless }) => {
    const r = await checkpointJournalRig()
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'many', role: 'assistant', content: [] } })
    for (let index = 0; index < count; index++) {
      if (index % 2) {
        r.stream({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' }
        })
      }
      r.stream({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: `thought-${index}` }
      })
    }
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    if (textless) {
      r.message({
        type: 'assistant',
        message: { id: 'many', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }
      })
    }
    r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await r.deferred.drained()
    const rows = r.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
    expect(rows).toHaveLength(count)
    for (const [index, row] of rows.entries()) {
      expect(row.body).toMatchObject({
        state: 'completed',
        blocks: [{ type: 'text', text: `thought-${index}` }]
      })
    }
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    r.translator.dispose()
    await r.journal.close()
    const reopened = await r.reopen()
    expect(
      reopened
        .snapshot()
        .items.filter((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
    ).toEqual(rows)
  }
)

it('keeps an assistant full snapshot through idle, a later delta, barrier and reopen', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  r.message({ type: 'user', uuid: 'u', message: { role: 'user', content: 'question' } })
  r.stream({ type: 'message_start', message: { id: 'reply' } })
  const delta = (text: string) =>
    r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  delta('P')
  vi.advanceTimersByTime(60)
  await r.deferred.drained()
  const key = 'claude:claude-session:block%3Areply%3A0'
  const before = r.journal.item(key)
  expect(before).not.toBeNull()
  r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  delta('T')
  vi.advanceTimersByTime(60)
  await r.deferred.drained()
  expect(r.journal.itemBody(key)).toMatchObject({ blocks: [{ type: 'text', text: 'P' }] })
  r.translator.flush()
  await r.deferred.drained()
  expect(r.journal.item(key)).toMatchObject({
    sequence: before?.sequence,
    observedAt: before?.observedAt,
    turnScope: before?.turnScope,
    body: { blocks: [{ type: 'text', text: 'PT' }] }
  })
  r.translator.dispose()
  const saved = r.journal.snapshot().items
  await r.journal.close()
  expect((await r.reopen()).snapshot().items).toEqual(saved)
})

it('does not autonomously retry a refused Claude snapshot across idle and next-send dispatch settlement', async () => {
  const r = await checkpointJournalRig({
    watermarks: {
      maxQueuedOperations: 1,
      maxLifecycleQueuedOperations: 1,
      lowQueuedOperations: 0,
      lowQueuedBytes: 0
    }
  })
  const { sessionFor, userMessage } = await import('./claude-structured-dispatch-test-support')
  const { dispatchClaudeTurn } = await import('./claude-structured-dispatch')
  const { resolveClaudeReplayTurn } = await import('./claude-replay-turn-resolution')
  const { bindClaudeJournalReadingControl } =
    await import('./claude-structured-session-journal-control')
  vi.useFakeTimers()
  vi.setSystemTime(0)
  r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
  await r.deferred.drained()
  const gate = Promise.withResolvers<void>()
  await r.journal.readInOrder(() => {
    void r.journal.readInOrder(() => gate.promise)
  })
  const id = (uuid: string) => ({ provider: 'claude' as const, sessionId: 'claude-session', uuid })
  r.deferred.sink.tryAppendItem?.(
    id('block-ordinary'),
    { kind: 'status', tone: 'info', text: 'ordinary' },
    { turnScope: { kind: 'thread' } }
  )
  r.deferred.sink.tryAppendItem?.(
    id('block-lifecycle'),
    { kind: 'status', tone: 'info', text: 'lifecycle' },
    { turnScope: { kind: 'thread' }, lifecycle: true }
  )
  const resume = vi.fn()
  const unbind = bindClaudeJournalReadingControl(
    r.deferred.sink,
    { pauseReading: vi.fn(), resumeReading: resume },
    r.translator
  )
  for (const [index, type, field] of [
    [0, 'text_delta', 'text'],
    [1, 'thinking_delta', 'thinking']
  ] as const) {
    r.stream({ type: 'content_block_delta', index, delta: { type, [field]: 'original answer' } })
  }
  vi.advanceTimersByTime(60)
  r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  expect(r.translator.pendingStreamedBlocks).toBe(1)
  const session = sessionFor()
  session.translator = r.translator
  session.events = r.deferred.sink
  session.providerSessionId = 'claude-session'
  const next = dispatchClaudeTurn(session, {
    clientMessageId: 'send-2',
    body: userMessage([{ type: 'text', text: 'next question' }])
  })
  await vi.advanceTimersByTimeAsync(0)
  await expect(next).resolves.toEqual({ state: 'admitted' })
  const uuid = session.dispatchWaiters[0]?.sentUuid
  expect(uuid).toBeTruthy()
  const echo = {
    type: 'user',
    uuid,
    session_id: 'claude-session',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'next question' }] }
  }
  expect(resolveClaudeReplayTurn(session, echo)).not.toBeNull()
  expect(session.dispatchWaiters).toHaveLength(0)
  r.translator.handle({ type: 'message', sessionId: 'recovery', startsTurn: true, message: echo })
  gate.resolve()
  await r.deferred.drained()
  await Promise.resolve()
  await r.deferred.drained()
  const answers = r.journal
    .snapshot()
    .items.filter((item) => item.body.kind === 'message' && item.body.role !== 'user')
  // Main consumes attempted checkpoints; admission observation adds no new retry owner.
  expect(answers).toHaveLength(0)
  expect(r.translator.finalOutputAdmitted).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  await r.deferred.drained()
  expect(
    r.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role !== 'user')
  ).toHaveLength(0)
  expect(resume).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  unbind?.()
  r.translator.dispose()
})

it('counts admitted unbound content for cadence without calling it written', async () => {
  const r = await checkpointJournalRig({ unbound: true })
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  r.stream({ type: 'message_start', message: { id: 'unbound' } })
  const delta = (text: string) =>
    r.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: text }
    })
  delta('P')
  vi.advanceTimersByTime(60)
  delta('T')
  vi.advanceTimersByTime(60)
  expect(r.journal.snapshot().items).toEqual([])
  r.bind()
  await r.deferred.drained()
  const key = 'claude:claude-session:block%3Aunbound%3A0'
  expect(r.journal.itemBody(key)).toMatchObject({ blocks: [{ type: 'text', text: 'P' }] })
  r.translator.flush()
  await expect(r.deferred.sink.written?.()).resolves.toEqual({ ok: true })
  expect(r.journal.itemBody(key)).toMatchObject({ blocks: [{ type: 'text', text: 'PT' }] })
  r.translator.dispose()
})
