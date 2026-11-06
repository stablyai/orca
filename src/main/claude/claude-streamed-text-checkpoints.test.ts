import { afterEach, expect, it, vi } from 'vitest'
import { checkpointJournalRig, closeCheckpointTestJournals } from './claude-checkpoint-test-support'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
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

it.each([100, 1000])(
  'joins a %i-window reply only for the saves it makes, then ends with the whole text',
  (windows) => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const saved: number[] = []
    const checkpoints = createClaudeStreamedTextCheckpoints({
      persist: (_identity, text) => {
        saved.push(text.length)
        return true
      },
      producer: {
        settledLinkageFor: () => {
          throw new Error('unscoped')
        }
      } as never
    })
    const identity = { provider: 'claude' as const, sessionId: 's', uuid: 'block:reply:0' }
    const join = Array.prototype.join
    let joined = 0
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string
    ) {
      const result = join.call(this, separator)
      if (separator === '') {
        joined += result.length
      }
      return result
    })
    for (let window = 0; window < windows; window++) {
      checkpoints.append(identity, 'x'.repeat(128))
      vi.advanceTimersByTime(60)
    }
    checkpoints.finish({})
    spy.mockRestore()
    // Every joined byte reaches a save: skipped windows cost nothing.
    expect(joined).toBe(saved.reduce((sum, length) => sum + length, 0))
    expect(saved.at(-1)).toBe(windows * 128)
    // One save per 400 ms of streaming plus the ending save.
    expect(saved.length).toBeLessThanOrEqual(Math.ceil((windows * 60) / 400) + 2)
    checkpoints.dispose()
  }
)
