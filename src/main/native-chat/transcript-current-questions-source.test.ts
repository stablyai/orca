import { appendFile, writeFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
import {
  readCurrentRequestsPiece,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import {
  acquireTranscriptCurrentQuestions,
  cancelTranscriptCurrentQuestions
} from './transcript-current-questions'
import * as fileVersions from './transcript-file-version'
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

it.each([40, 400])(
  'admits A/B append growth without replay or definition work for %i pending records and independent 10x definitions',
  async (count) => {
    const f = await fixture()
    const io = sourceIo(f.path)
    const ops = sourceOperations(f)
    const decode = vi.fn(decodeWithClear)
    const q = sourceQuery(f, 'growth', decode)
    for (const bytes of [1000, 10_000]) {
      await writeFile(
        f.path,
        Array.from({ length: count }, (_, i) => question(`q-${i}`, 'd'.repeat(bytes))).join('')
      )
      const initial = await q.read()
      const saved = f.repository.current(q.source)
      for (const record of saved.pending) {
        const questions = record.questions
        Object.defineProperty(record, 'questions', {
          configurable: true,
          enumerable: true,
          get: () => {
            ops.counts.definitions++
            return questions
          }
        })
      }
      for (const phase of ['A', 'B']) {
        const initialReads = io.ranges.length
        const start = (await fileVersions.readTranscriptFileVersion(f.path)).size
        let injected = false
        const originalVersion = fileVersions.readTranscriptFileVersion
        const originalBoundary = fileVersions.boundaryFingerprint
        const probe =
          phase === 'A'
            ? vi
                .spyOn(fileVersions, 'readTranscriptFileVersion')
                .mockImplementation(async (...args) => {
                  const result = await originalVersion(...args)
                  if (!injected) {
                    injected = true
                    await appendFile(f.path, output(`${phase}-${bytes}-after-opening`))
                  }
                  return result
                })
            : vi.spyOn(fileVersions, 'boundaryFingerprint').mockImplementation(async (...args) => {
                const result = await originalBoundary(...args)
                if (!injected) {
                  injected = true
                  await appendFile(f.path, output(`${phase}-${bytes}-after-probe`))
                }
                return result
              })
        ops.reset()
        decode.mockClear()
        const statsBefore = io.counts.stats
        await appendFile(f.path, output(`${phase}-${bytes}-before`))
        expect(await q.read()).toBe(initial)
        probe.mockRestore()
        expect(injected).toBe(true)
        const finish = (await fileVersions.readTranscriptFileVersion(f.path)).size
        // Two bracketed observations at each frontier, plus this diagnostic finish stat.
        expect(io.counts.stats - statsBefore).toBe(5)
        expect(io.ranges.slice(initialReads).map((range) => range.start)).toEqual([start])
        expect(io.ranges.slice(initialReads).reduce((sum, range) => sum + range.bytes, 0)).toBe(
          finish - start
        )
        expect(decode).toHaveBeenCalledTimes(2)
        expect(ops.summary()).toMatchObject({
          definitions: 0,
          schema: 0,
          definitionJson: 0,
          selects: 0,
          ingest: 2,
          repository: 1
        })
        const steady = ops.summary()
        for (let i = 0; i < 10; i++) {
          expect(await q.read()).toBe(initial)
        }
        expect(ops.summary()).toEqual(steady)
        console.log('source-growth-counts', {
          count,
          bytes,
          phase,
          sourceBytes: finish - start,
          ...io.counts,
          ...steady
        })
      }
    }
  },
  30_000
)

it.each([40, 400])(
  'continues a query-only known control tail and coalesces fresh Cancel after capture for %i saved questions',
  async (count) => {
    const f = await fixture()
    await writeFile(f.path, Array.from({ length: count }, (_, i) => question(`q-${i}`)).join(''))
    const io = sourceIo(f.path)
    const q = sourceQuery(f, 'tail')
    const before = await q.read()
    const saved = f.repository.current(q.source).pending
    const states: AgentSessionCurrentRequestsState[] = [{}, {}]
    let latest = before
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
      'tail',
      decodeWithClear,
      (projection) => {
        latest = projection
        bindings.forEach((binding) =>
          binding.observe({ type: 'appended', currentRequests: projection.marker })
        )
      },
      f.repository
    )
    // Release stream interest: only the original finite query/idle ownership can continue the tail.
    interest.dispose()
    let captured = false
    io.onNext(async (range) => {
      if (captured || range.chunks) {
        return
      }
      captured = true
      await appendFile(
        f.path,
        question('tail-q1') +
          output('earlier-human', 'user') +
          question('tail-q2') +
          clearRow('clear-tail') +
          question('tail-q3') +
          stopRow('tail-stop') +
          question('last-pending')
      )
    })
    const baseline = io.ranges.length
    await appendFile(f.path, output('captured-output'))
    expect(await q.read()).toBe(before)
    // Diagnostic reads of the existing repository do not ask for a source refresh.
    await vi.waitFor(() =>
      expect(f.repository.current(q.source).pending.map((row) => row.sourceRowId)).toEqual([
        'last-pending'
      ])
    )
    expect(io.ranges.slice(baseline)).toHaveLength(2)
    expect(io.ranges[baseline + 1].start).toBe(io.ranges[baseline].end + 1)
    const records = f.repository.current(q.source).records
    expect(
      records.filter((row) => saved.some((old) => old.id === row.id)).map((row) => row.resolution)
    ).toEqual(
      saved.map(() => ({
        state: 'resolved',
        reason: 'delivery',
        factId: 'earlier-human',
        resolvedBy: null,
        resolvedAt: null
      }))
    )
    expect(records.find((row) => row.sourceRowId === 'tail-q2')?.resolution).toMatchObject({
      state: 'cancelled',
      reason: 'context',
      factId: 'clear-tail'
    })
    expect(records.find((row) => row.sourceRowId === 'tail-q3')?.resolution).toMatchObject({
      state: 'cancelled',
      reason: 'interruption',
      factId: 'tail-stop'
    })
    // A second acquisition supplies the actual publication notification without driving source work.
    const observer = acquireTranscriptCurrentQuestions(
      f.path,
      'codex',
      'tail',
      decodeWithClear,
      (projection) => {
        latest = projection
        bindings.forEach((binding) =>
          binding.observe({ type: 'appended', currentRequests: projection.marker })
        )
      },
      f.repository
    )
    cleanup.push(observer.dispose)
    await vi.waitFor(() =>
      states.forEach((state) => expect(currentMessageQuestionView(state)?.ready).toBe(true))
    )
    expect(states.map((state) => state.asyncQuestions?.map((row) => row.sourceRowId))).toEqual([
      ['last-pending'],
      ['last-pending']
    ])
    let cancel: Promise<void> | undefined
    let joined: Promise<CurrentRequestsProjection>[] = []
    const cancelRanges = io.ranges.length
    captured = false
    io.onNext(async (range) => {
      if (captured || range.chunks) {
        return
      }
      captured = true
      await appendFile(f.path, output('delivered-after-cancel-request', 'user'))
      joined = Array.from({ length: count }, () => q.read())
      cancel = cancelTranscriptCurrentQuestions(
        f.path,
        'codex',
        'tail',
        decodeWithClear,
        f.repository.current(q.source).pending.map((row) => row.id),
        'client',
        1,
        undefined,
        f.repository
      )
    })
    await appendFile(f.path, output('capture-before-cancel'))
    await q.read()
    expect(cancel).toBeDefined()
    await cancel
    await Promise.all(joined)
    expect(io.ranges.slice(cancelRanges)).toHaveLength(2)
    expect(
      f.repository.current(q.source).records.find((row) => row.sourceRowId === 'last-pending')
        ?.resolution
    ).toMatchObject({
      state: 'resolved',
      reason: 'delivery',
      factId: 'delivered-after-cancel-request'
    })
    console.log('query-tail-ranges', { count, ranges: io.ranges, ...io.counts })
  }
)

it.each([40, 400])(
  'finishes finite cold captures during continuous growth and parks a partial EOF without spin for %i questions',
  async (count) => {
    const f = await fixture()
    await writeFile(f.path, Array.from({ length: count }, (_, i) => question(`cold-${i}`)).join(''))
    const io = sourceIo(f.path)
    const decode = vi.fn(decodeWithClear)
    const q = sourceQuery(f, 'cold-growth', decode)
    let growth = 0
    const changed = new Set<object>()
    io.onNext(async (range) => {
      if (!range.chunks || changed.has(range) || growth >= 4) {
        return
      }
      changed.add(range)
      await appendFile(f.path, output(`growth-${growth++}`))
    })
    await q.read()
    await vi.waitFor(() => expect(io.ranges).toHaveLength(5))
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(count + 4))
    expect(io.ranges.filter((range) => range.start === 0)).toHaveLength(1)
    for (let i = 1; i < io.ranges.length; i++) {
      expect(io.ranges[i].start).toBe(io.ranges[i - 1].end + 1)
    }
    expect(io.ranges.reduce((sum, range) => sum + range.bytes, 0)).toBe(
      (await fileVersions.readTranscriptFileVersion(f.path)).size
    )
    io.onNext(undefined)
    const beforeOversized = decode.mock.calls.length
    const oversizedRanges = io.ranges.length
    await appendFile(f.path, longOutput('oversized', 2 * 1024 * 1024) + output('after-oversized'))
    await q.read()
    console.log('oversized-source-progress', {
      count,
      beforeOversized,
      decodes: decode.mock.calls.length,
      ranges: io.ranges,
      ...io.counts
    })
    expect(decode).toHaveBeenCalledTimes(beforeOversized + 1)
    expect(io.ranges.filter((range) => range.start === 0)).toHaveLength(1)
    expect(io.ranges.slice(oversizedRanges)).toHaveLength(1)
    expect(io.ranges[oversizedRanges].start).toBe(io.ranges[oversizedRanges - 1].end + 1)
    expect(f.repository.current(q.source).pending).toHaveLength(count)
    const fullOption = '🟦'.repeat(20_000)
    const unterminated = question('split-utf8', fullOption).trimEnd()
    await appendFile(f.path, unterminated)
    const unchanged = await q.read()
    expect(f.repository.current(q.source).pending).toHaveLength(count)
    const parked = io.ranges.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(io.ranges).toHaveLength(parked)
    await appendFile(f.path, '\r\n')
    const complete = await q.read()
    expect(complete.marker.version).not.toBe(unchanged.marker.version)
    expect(f.repository.current(q.source).pending).toHaveLength(count + 1)
    expect(
      f.repository.current(q.source).pending.find((record) => record.sourceRowId === 'split-utf8')
        ?.questions[0].options[0].label
    ).toBe(fullOption)
    console.log('cold-source-ranges', { count, ranges: io.ranges, ...io.counts })
  }
)

it.each([40, 400])(
  'recovers semantic bytes with fresh provenance after unknown without touching %i old definitions',
  async (count) => {
    const f = await fixture()
    await writeFile(
      f.path,
      Array.from({ length: count }, (_, i) => question(`memo-${i}`, 'large'.repeat(2000))).join('')
    )
    const io = sourceIo(f.path)
    const ops = sourceOperations(f)
    const q = sourceQuery(f, 'memo')
    const before = await q.read()
    for (const record of f.repository.current(q.source).pending) {
      const questions = record.questions
      Object.defineProperty(record, 'questions', {
        configurable: true,
        enumerable: true,
        get: () => {
          ops.counts.definitions++
          return questions
        }
      })
    }
    const stat = fileVersions.readTranscriptFileVersion
    const failure = vi
      .spyOn(fileVersions, 'readTranscriptFileVersion')
      .mockRejectedValue(new Error('Temporary source stat failure'))
    ops.reset()
    const unknown = await q.read()
    expect(unknown.items).toBeUndefined()
    expect(await q.read()).toBe(unknown)
    failure.mockImplementation(stat)
    const recovered = await q.read()
    expect(recovered.items).toBe(before.items)
    expect(recovered.json).toBe(before.json)
    expect(recovered.marker.publisher).toBe(before.marker.publisher)
    expect(recovered.marker.version).not.toBe(before.marker.version)
    expect(io.ranges).toHaveLength(1)
    expect(ops.summary()).toMatchObject({
      selects: 0,
      definitions: 0,
      schema: 0,
      definitionJson: 0,
      ingest: 0,
      repository: 0
    })
    const stale = readCurrentRequestsPiece(recovered, {
      sessionId: q.source.sessionId,
      version: before.marker.version
    })
    expect(stale.restart).toBe(true)
    expect(stale.marker).toBe(recovered.marker)
    console.log('semantic-recovery-counts', { count, ...io.counts, ...ops.summary() })
  }
)

it('retains the original partial target and withdraws a qualified shorter unread tail without spinning', async () => {
  const f = await fixture()
  await writeFile(f.path, question('saved'))
  const io = sourceIo(f.path)
  const q = sourceQuery(f, 'partial-target')
  await q.read()
  await appendFile(f.path, output('complete-before-loss') + longOutput('unfinished', 180_000))
  const baseline = io.ranges.length
  let failed = false
  io.onNext(async (range) => {
    if (!failed && range.chunks) {
      failed = true
      throw new Error('partial-target EIO')
    }
  })
  expect((await q.read()).items).toBeUndefined()
  await vi.waitFor(() => expect(io.counts.destroyed).toBe(io.ranges.length))
  const frontier = io.ranges[baseline].start + io.ranges[baseline].bytes
  // Keep the acquired boundary and carry, but withdraw an unacquired suffix of the original extent.
  await truncate(f.path, frontier + 100)
  io.onNext(undefined)
  expect((await q.read()).items).toBeDefined()
  expect(io.ranges[baseline + 1]).toMatchObject({ start: frontier, end: frontier + 99, bytes: 100 })
  const parked = io.ranges.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(io.ranges).toHaveLength(parked)
  expect(f.repository.current(q.source).pending.map((record) => record.sourceRowId)).toEqual([
    'saved'
  ])
})

it('retains a short acquisition as unknown, resumes its finite extent and stages saved terminal outcomes across storage failure', async () => {
  const f = await fixture()
  await writeFile(f.path, Array.from({ length: 40 }, (_, i) => question(`saved-${i}`)).join(''))
  const io = sourceIo(f.path)
  const q = sourceQuery(f, 'short-storage')
  await q.read()
  const saved = f.repository.current(q.source)
  const tail =
    output('first-human', 'user') + longOutput('split-row', 180_000) + stopRow('later-stop')
  await appendFile(f.path, tail)
  const baseline = io.ranges.length
  let shortened = false
  io.onNext(async (range) => {
    if (!shortened && range.chunks) {
      shortened = true
      return 'short'
    }
  })
  expect((await q.read()).items).toBeUndefined()
  expect(shortened).toBe(true)
  expect(f.repository.current(q.source)).toBe(saved)
  io.onNext(undefined)
  f.database.db.exec(
    "CREATE TEMP TRIGGER fail_first_terminal BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated terminal write failure'); END"
  )
  try {
    const nullPublication = await q.read()
    expect(
      nullPublication.items &&
        !Array.isArray(nullPublication.items) &&
        nullPublication.items.asyncQuestions
    ).toBeNull()
    expect(f.repository.current(q.source)).toBe(saved)
    expect(io.ranges[baseline + 1].start).toBe(
      io.ranges[baseline].start + io.ranges[baseline].bytes
    )
    expect(io.ranges.slice(baseline).reduce((sum, range) => sum + range.bytes, 0)).toBe(
      Buffer.byteLength(tail)
    )
  } finally {
    f.database.db.exec('DROP TRIGGER fail_first_terminal')
  }
  const reads = io.ranges.length
  await q.read()
  expect(io.ranges).toHaveLength(reads)
  const terminal = f.repository.current(q.source).records
  expect(terminal.map((record) => record.resolution)).toEqual(
    saved.records.map(() => ({
      state: 'resolved',
      reason: 'delivery',
      factId: 'first-human',
      resolvedBy: null,
      resolvedAt: null
    }))
  )
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(30_001)
  f.database.close()
  f.database = JournalHostDatabase.open(join(f.path, '..', 'host'))
  f.repository = messageQuestionsFor(f.database)
  const reopened = await q.read()
  expect(reopened.items && !Array.isArray(reopened.items) && reopened.items.asyncQuestions).toEqual(
    []
  )
  expect(f.repository.current(q.source).records).toEqual(terminal)
})

it.each([40, 400])(
  'publishes each admitted replacement before its growing tail is quiet for %i questions',
  async (count) => {
    const f = await fixture()
    await writeFile(f.path, Array.from({ length: count }, (_, i) => question(`old-${i}`)).join(''))
    const io = sourceIo(f.path)
    const decode = vi.fn(decodeWithClear)
    const q = sourceQuery(f, 'replacement-growth', decode)
    await q.read()
    const old = f.repository.current(q.source).pending
    await cancelTranscriptCurrentQuestions(
      f.path,
      'codex',
      q.source.sessionId,
      decode,
      [old[0].id],
      'phone',
      1,
      undefined,
      f.repository
    )
    const baseline = io.ranges.length
    const originalVersion = fileVersions.readTranscriptFileVersion
    const replacement =
      question('old-0') +
      Array.from({ length: count }, (_, i) =>
        question(`new-${i}`, 'full option '.repeat(1000))
      ).join('')
    await truncate(f.path, 0)
    await writeFile(f.path, replacement)
    let growth = 0
    const changed = new Set<object>()
    io.onNext(async (range) => {
      if (!range.chunks || changed.has(range) || growth === 4) {
        return
      }
      changed.add(range)
      await appendFile(f.path, output(`replacement-tail-${growth++}`))
    })
    decode.mockClear()
    const stringify = JSON.stringify
    const ops = sourceOperations(f)
    const admitted = await q.read()
    expect(
      admitted.items && !Array.isArray(admitted.items) && admitted.items.asyncQuestions
    ).toHaveLength(count)
    expect(growth).toBeGreaterThan(0)
    expect(growth).toBeLessThan(4)
    expect(
      f.repository.current(q.source).records.find((row) => row.id === old[0].id)?.resolution
    ).toMatchObject({ state: 'cancelled', reason: 'user' })
    expect(
      f.repository.current(q.source).records.find((row) => row.id === old[1].id)?.resolution
    ).toMatchObject({ state: 'cancelled', reason: 'source-replaced' })
    const displayed = f.repository.current(q.source).pending[0].id
    // A dispatched exact action joins the finite follow-up, not all later output.
    await cancelTranscriptCurrentQuestions(
      f.path,
      'codex',
      q.source.sessionId,
      decode,
      [displayed],
      'phone',
      2,
      undefined,
      f.repository
    )
    await vi.waitFor(() => expect(growth).toBe(4))
    await vi.waitFor(() => expect(io.ranges.slice(baseline)).toHaveLength(5))
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(count + 5))
    const ranges = io.ranges.slice(baseline)
    expect(ranges.filter((range) => range.start === 0)).toHaveLength(1)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end + 1)
    }
    expect(decode).toHaveBeenCalledTimes(count + 5)
    expect(ranges.reduce((sum, range) => sum + range.bytes, 0)).toBe(
      (await originalVersion(f.path)).size
    )
    expect(
      f.repository.current(q.source).records.find((row) => row.id === displayed)?.resolution.state
    ).toBe('cancelled')
    expect(ops.ingest).toHaveBeenCalledTimes(count + 5)
    const definitionBytes = ops.stringify.mock.calls
      .filter(
        ([value]) =>
          value !== null &&
          typeof value === 'object' &&
          ('responseMode' in value || 'asyncQuestions' in value)
      )
      .reduce((sum, [value]) => sum + Buffer.byteLength(stringify(value)), 0)
    console.log('replacement-finite-ranges', {
      count,
      ranges,
      definitionBytes,
      ...io.counts,
      ...ops.summary()
    })
  },
  30_000
)
