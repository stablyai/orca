import { appendFile, writeFile, rename } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { MessageQuestionIngest } from './message-question-ingest'
import { readCurrentRequestsPiece } from './agent-session-wire/agent-session-current-requests'
import {
  acquireTranscriptCurrentQuestions,
  cancelTranscriptCurrentQuestions
} from './transcript-current-questions'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages
} from './transcript-incremental-reader'
import * as fileVersions from './transcript-file-version'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { createNativeChatCurrentRequestsBinding } from '../../shared/native-chat-current-requests-binding'
import {
  currentMessageQuestionView,
  type AgentSessionCurrentRequestsState
} from '../../shared/agent-session-current-requests'
import { cleanup, fixture, question, output } from './transcript-current-questions-test-fixture'
import {
  clearRow,
  decodeWithClear,
  stopRow,
  longOutput,
  sourceIo,
  sourceOperations,
  sourceQuery
} from './transcript-current-questions-source-test-fixture'

it.each([
  ['question', 1],
  ['human', 7],
  ['stop', 39],
  ['clear', 7]
] as const)(
  'hands off %s with %i residual complete rows on real stream-next I/O failure before retaining progress',
  async (kind, residual) => {
    const f = await fixture()
    await writeFile(f.path, Array.from({ length: 40 }, (_, i) => question(`saved-${i}`)).join(''))
    const io = sourceIo(f.path)
    const ops = sourceOperations(f)
    const decode = vi.fn(decodeWithClear)
    const q = sourceQuery(f, `io-${kind}`, decode)
    const before = await q.read()
    const saved = f.repository.current(q.source).pending
    let latest = before
    const states: AgentSessionCurrentRequestsState[] = [{}, {}]
    const bindings = states.map((_state, i) =>
      createNativeChatCurrentRequestsBinding({
        read: async (request) => readCurrentRequestsPiece(latest, request),
        publish: (state) => {
          states[i] = state
        }
      })
    )
    cleanup.push(() => bindings.forEach((binding) => binding.invalidate()))
    const interest = acquireTranscriptCurrentQuestions(
      f.path,
      'codex',
      q.source.sessionId,
      decode,
      (projection) => {
        latest = projection
        bindings.forEach((binding) =>
          binding.observe({ type: 'appended', currentRequests: projection.marker })
        )
      },
      f.repository
    )
    cleanup.push(interest.dispose)
    await vi.waitFor(() =>
      states.forEach((state) => expect(currentMessageQuestionView(state)?.ready).toBe(true))
    )
    const control =
      kind === 'question'
        ? question('residual-question')
        : kind === 'human'
          ? output('residual-human', 'user')
          : kind === 'stop'
            ? stopRow('residual-stop')
            : clearRow('residual-clear')
    const tail =
      control +
      Array.from({ length: residual - 1 }, (_, i) => output(`residual-${i}`)).join('') +
      longOutput('partial-row', 180_000)
    await appendFile(f.path, tail)
    const first = io.ranges.length
    let failed = false
    io.onNext(async (range) => {
      if (!failed && range.chunks === 1) {
        failed = true
        throw new Error('Injected stream-next EIO')
      }
    })
    ops.reset()
    decode.mockClear()
    const unknown = await q.read()
    expect(failed).toBe(true)
    expect(unknown.items).toBeUndefined()
    expect(io.ranges[first].bytes).toBe(65_536)
    expect(decode).toHaveBeenCalledTimes(residual)
    expect(ops.ingest).toHaveBeenCalledTimes(residual)
    expect(ops.reconcile).not.toHaveBeenCalled()
    expect(f.repository.current(q.source).pending).toEqual(saved)
    await vi.waitFor(() =>
      states.forEach((state) => expect(currentMessageQuestionView(state)?.ready).toBe(false))
    )
    // Restore only I/O, then use a legitimate existing resource read; no additional source bytes/Send.
    io.onNext(undefined)
    const recovered = await q.read()
    expect(io.ranges[first + 1].start).toBe(io.ranges[first].start + 65_536)
    expect(io.ranges.slice(first).reduce((sum, range) => sum + range.bytes, 0)).toBe(
      Buffer.byteLength(tail)
    )
    expect(decode).toHaveBeenCalledTimes(residual + 1)
    const after = f.repository.current(q.source)
    if (kind === 'question') {
      expect(after.pending.map((row) => row.sourceRowId)).toContain('residual-question')
    } else {
      expect(
        after.records
          .filter((row) => saved.some((old) => old.id === row.id))
          .map((row) => row.resolution)
      ).toEqual(
        saved.map(() => ({
          state: kind === 'human' ? 'resolved' : 'cancelled',
          reason: kind === 'human' ? 'delivery' : kind === 'stop' ? 'interruption' : 'context',
          factId: `residual-${kind}`,
          resolvedBy: null,
          resolvedAt: null
        }))
      )
    }
    expect(recovered.marker.publisher).toBe(before.marker.publisher)
    await vi.waitFor(() =>
      states.forEach((state) => {
        expect(currentMessageQuestionView(state)?.ready).toBe(true)
        expect(state.asyncQuestions).toEqual(after.pending)
      })
    )
    await vi.waitFor(() => expect(io.counts.destroyed).toBe(io.ranges.length))
    console.log('residual-source-io-counts', {
      kind,
      residual,
      ranges: io.ranges,
      ...io.counts,
      ...ops.summary()
    })
  }
)

it.each(['decoder', 'callback', 'handoff'] as const)(
  'quarantines an unsafe %s fold before any durable terminal write and rederives cleanly',
  async (phase) => {
    const f = await fixture()
    await writeFile(f.path, question('saved'))
    const io = sourceIo(f.path)
    let armed = false,
      failed = false
    const decode = vi.fn((line: string, fallback: string) => {
      const message = decodeWithClear(line, fallback)
      if (armed && !failed && phase === 'decoder' && message?.id === 'after-human') {
        failed = true
        throw new Error('Unsafe decoder')
      }
      return message
    })
    const q = sourceQuery(f, `unsafe-${phase}`, decode)
    await q.read()
    const prior = f.repository.current(q.source)
    const append = MessageQuestionIngest.prototype.append
    vi.spyOn(MessageQuestionIngest.prototype, 'append').mockImplementation(function (...args) {
      const result = append.apply(this, args)
      if (armed && !failed && phase !== 'decoder' && args[0].id === 'unsafe-human') {
        failed = true
        throw new Error('Unsafe partially applied callback')
      }
      return result
    })
    await appendFile(
      f.path,
      output('unsafe-human', 'user') +
        output('after-human') +
        Array.from({ length: phase === 'handoff' ? 0 : 39 }, (_, i) => output(`batch-${i}`)).join(
          ''
        ) +
        longOutput('carry', 180_000) +
        stopRow('later-stop')
    )
    const reconcile = vi.spyOn(f.repository, 'reconcile')
    const first = io.ranges.length
    armed = true
    if (phase === 'handoff') {
      io.onNext(async (range) => {
        if (!failed && range.chunks) {
          throw new Error('stream-next before unsafe handoff')
        }
      })
    }
    expect((await q.read()).items).toBeUndefined()
    expect(failed).toBe(true)
    expect(reconcile).not.toHaveBeenCalled()
    expect(f.repository.current(q.source)).toBe(prior)
    armed = false
    io.onNext(undefined)
    await q.read()
    expect(io.ranges[first + 1].start).toBe(0)
    expect(
      f.repository.current(q.source).records.find((row) => row.sourceRowId === 'saved')?.resolution
    ).toMatchObject({ state: 'resolved', reason: 'delivery', factId: 'unsafe-human' })
    await vi.waitFor(() => expect(io.counts.destroyed).toBe(io.ranges.length))
  }
)

it('keeps default history/no-batch/lifecycle reader behavior isolated from source-only I/O handoff', async () => {
  const f = await fixture()
  await writeFile(f.path, output('baseline-user', 'user') + longOutput('baseline-partial', 180_000))
  const io = sourceIo(f.path)
  for (const batched of [false, true]) {
    const state = createIncrementalTranscriptState()
    const onBatch = vi.fn()
    const lifecycle = vi.fn(() => null)
    let failed = false
    io.onNext(async (range) => {
      if (!failed && range.chunks) {
        failed = true
        throw new Error('default EIO')
      }
    })
    await expect(
      readIncrementalTranscriptMessages(
        f.path,
        state,
        decodeCodexTranscriptLine,
        batched ? onBatch : undefined,
        lifecycle
      )
    ).rejects.toThrow('default EIO')
    expect(state.offset).toBe(65_536)
    expect(onBatch).not.toHaveBeenCalled()
    expect(lifecycle).toHaveBeenCalledTimes(1)
    io.onNext(undefined)
    const remaining = await readIncrementalTranscriptMessages(
      f.path,
      state,
      decodeCodexTranscriptLine,
      batched ? onBatch : undefined,
      lifecycle
    )
    // This inherited default-consumer loss is measured here, not claimed repaired.
    expect(remaining.map((row) => row.id)).toEqual(['baseline-partial'])
  }
  await vi.waitFor(() => expect(io.counts.destroyed).toBe(io.ranges.length))
})

it.each(['rename', 'truncate', 'larger', 'sampled-boundary'] as const)(
  'reconstructs actual detected %s replacement and retains only canonical outcomes, including mid-probe identity change',
  async (kind) => {
    const f = await fixture()
    const original = question('retained') + question('removed') + longOutput('old-pad', 3000)
    await writeFile(f.path, original)
    const io = sourceIo(f.path)
    const q = sourceQuery(f, `replace-${kind}`)
    await q.read()
    const displayed = f.repository.current(q.source).pending
    await cancelTranscriptCurrentQuestions(
      f.path,
      'codex',
      q.source.sessionId,
      decodeWithClear,
      [displayed[0].id],
      'client',
      1,
      undefined,
      f.repository
    )
    const replacement =
      question('retained') +
      question('new') +
      (kind === 'truncate' ? '' : longOutput('new-pad', 6000))
    const baseline = io.ranges.length
    if (kind === 'rename') {
      const probe = fileVersions.boundaryFingerprint
      let changed = false
      vi.spyOn(fileVersions, 'boundaryFingerprint').mockImplementation(async (...args) => {
        const result = await probe(...args)
        if (!changed) {
          changed = true
          const path = `${f.path}.replacement`
          await writeFile(path, replacement)
          await rename(path, f.path)
        }
        return result
      })
    } else if (kind === 'sampled-boundary') {
      let changed = false
      io.onNext(async (range) => {
        if (!changed && range.chunks) {
          changed = true
          await writeFile(f.path, replacement)
        }
      })
      await appendFile(f.path, output('read-before-replacement'))
      expect((await q.read()).items).toBeUndefined()
      io.onNext(undefined)
    } else {
      await writeFile(f.path, replacement)
    }
    await q.read()
    expect(io.ranges[baseline + (kind === 'sampled-boundary' ? 1 : 0)].start).toBe(0)
    const records = f.repository.current(q.source)
    expect(records.pending.map((row) => row.sourceRowId)).toEqual(['new'])
    expect(records.records.find((row) => row.sourceRowId === 'retained')).toMatchObject({
      id: displayed[0].id,
      resolution: { state: 'cancelled', reason: 'user' }
    })
    expect(records.records.find((row) => row.sourceRowId === 'removed')?.resolution).toMatchObject({
      state: 'cancelled',
      reason: 'source-replaced'
    })
  }
)
