import { appendFile, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { MessageQuestionIngest } from './message-question-ingest'
import * as lifecycle from './message-question-lifecycle'
import {
  readCurrentRequestsPiece,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import {
  acquireTranscriptCurrentQuestions,
  cancelTranscriptCurrentQuestions,
  queryTranscriptCurrentQuestions
} from './transcript-current-questions'
import * as fileVersions from './transcript-file-version'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { installTranscriptWatcher } from './transcript-watch-engine'
import { cleanup, fixture, question, output } from './transcript-current-questions-test-fixture'

it.each([10, 100])(
  'preserves ordered terminal outcomes through a complete terminal replay of %i answer/Stop boundaries',
  async (count) => {
    const f = await fixture()
    const rows: string[] = []
    for (let i = 0; i < count; i++) {
      rows.push(
        question(`answered-${i}`, `answered-${i}`),
        output(`human-${i}`, 'user'),
        question(`stopped-${i}`, `stopped-${i}`),
        `${JSON.stringify({ type: 'event_msg', payload: { id: `stop-${i}`, type: 'turn_aborted' } })}\n`
      )
    }
    rows.push(question('pending'))
    await writeFile(f.path, rows.join(''))
    const decode = vi.fn(decodeCodexTranscriptLine)
    const ingest = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const settle = vi.spyOn(lifecycle, 'reconcileMessageQuestionResolution')
    const reconcile = vi.spyOn(f.repository, 'reconcile')
    const query = () =>
      queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        'ordered',
        decode,
        (projection) => projection,
        undefined,
        f.repository
      )
    const publication = await query()
    const source = {
      kind: 'transcript' as const,
      agent: 'codex',
      sessionId: 'ordered',
      filePath: f.path
    }
    const records = f.repository.current(source).records
    expect(records.filter((record) => record.resolution.state === 'resolved')).toHaveLength(count)
    expect(records.filter((record) => record.resolution.state === 'cancelled')).toHaveLength(count)
    expect(records.filter((record) => record.resolution.state === 'pending')).toHaveLength(1)
    const operations = {
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      lifecycle: settle.mock.calls.length,
      repository: reconcile.mock.calls.length
    }
    expect(operations.decoder).toBe(4 * count + 1)
    expect(operations.ingest).toBe(4 * count + 1)
    expect(operations.lifecycle).toBeGreaterThan(2 * count)
    expect(operations.lifecycle).toBeLessThanOrEqual(6 * count + 2)
    expect(operations.repository).toBe(1)
    for (let i = 0; i < 10; i++) {
      expect(await query()).toBe(publication)
    }
    expect({
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      lifecycle: settle.mock.calls.length,
      repository: reconcile.mock.calls.length
    }).toEqual(operations)
    console.log('question-terminal-replay-operations', {
      count,
      ...operations,
      unchangedQueries: 10
    })
  }
)

it('fans genuine delivery into native and positional contexts without reusing a revised human ID', async () => {
  const f = await fixture()
  const source = {
    kind: 'transcript' as const,
    agent: 'codex',
    sessionId: 'dual-context',
    filePath: f.path
  }
  const query = () =>
    queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      source.sessionId,
      decodeCodexTranscriptLine,
      (projection) => projection,
      undefined,
      f.repository
    )
  await writeFile(
    f.path,
    question('native-before') + question('positional-before', 'A choice', true)
  )
  await query()
  const before = f.repository.current(source).pending
  expect(before).toHaveLength(2)
  expect(new Set(before.map((record) => record.context)).size).toBe(2)
  await appendFile(
    f.path,
    output('same-human', 'user') +
      question('native-after') +
      question('positional-after', 'A choice', true)
  )
  await query()
  const after = f.repository.current(source).pending
  expect(after).toHaveLength(2)
  const delivered = before.map((record) => ({
    ...record,
    resolution: {
      state: 'resolved',
      reason: 'delivery',
      factId: 'same-human',
      resolvedAt: null,
      resolvedBy: null
    }
  }))
  expect(
    f.repository
      .current(source)
      .records.filter((record) => before.some((old) => old.id === record.id))
  ).toEqual(delivered)
  await appendFile(f.path, output('same-human', 'user'))
  await query()
  expect(f.repository.current(source).pending).toEqual(after)
  await appendFile(
    f.path,
    `${JSON.stringify({ type: 'event_msg', payload: { id: 'later-stop', type: 'turn_aborted' } })}\n`
  )
  await query()
  const records = f.repository.current(source).records
  expect(records.filter((record) => before.some((old) => old.id === record.id))).toEqual(delivered)
  expect(
    records
      .filter((record) => after.some((old) => old.id === record.id))
      .map((record) => record.resolution)
  ).toEqual(
    after.map(() => ({
      state: 'cancelled',
      reason: 'interruption',
      factId: 'later-stop',
      resolvedAt: null,
      resolvedBy: null
    }))
  )
})

it.each([40, 400])(
  'preserves delivered outcomes for %i already-saved terminal questions before a batched later Stop',
  async (count) => {
    const f = await fixture()
    await writeFile(
      f.path,
      Array.from({ length: count }, (_, i) => question(`saved-${i}`, 'A choice', i % 2 === 1)).join(
        ''
      )
    )
    const decode = vi.fn(decodeCodexTranscriptLine)
    const ingest = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const settle = vi.spyOn(lifecycle, 'reconcileMessageQuestionResolution')
    const reconcile = vi.spyOn(f.repository, 'reconcile')
    const query = () =>
      queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        'saved-order',
        decode,
        (projection) => projection,
        undefined,
        f.repository
      )
    await query()
    const source = {
      kind: 'transcript' as const,
      agent: 'codex',
      sessionId: 'saved-order',
      filePath: f.path
    }
    const before = f.repository.current(source).pending
    expect(before).toHaveLength(count)
    await appendFile(
      f.path,
      `${output('delivered-before-stop', 'user')}${Array.from({ length: count }, (_, i) => question(`later-${i}`, 'A choice', i % 2 === 1)).join('')}${JSON.stringify({ type: 'event_msg', payload: { id: 'batched-stop', type: 'turn_aborted' } })}\n${question('still-pending')}`
    )
    const publication = await query()
    const records = f.repository.current(source).records
    const savedIds = new Set(before.map((record) => record.id))
    expect(
      records.filter((record) => savedIds.has(record.id)).map((record) => record.resolution)
    ).toEqual(
      before.map(() => ({
        state: 'resolved',
        reason: 'delivery',
        factId: 'delivered-before-stop',
        resolvedAt: null,
        resolvedBy: null
      }))
    )
    expect(records.filter((record) => record.resolution.state === 'cancelled')).toHaveLength(count)
    expect(f.repository.current(source).pending.map((record) => record.sourceRowId)).toEqual([
      'still-pending'
    ])
    const operations = {
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      lifecycle: settle.mock.calls.length,
      repository: reconcile.mock.calls.length
    }
    expect(operations.decoder).toBe(2 * count + 3)
    expect(operations.ingest).toBe(2 * count + 3)
    expect(operations.lifecycle).toBeLessThanOrEqual(6 * count + 3)
    expect(operations.repository).toBe(2)
    for (let i = 0; i < 10; i++) {
      expect(await query()).toBe(publication)
    }
    expect({
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      lifecycle: settle.mock.calls.length,
      repository: reconcile.mock.calls.length
    }).toEqual(operations)
    console.log('question-terminal-saved-batch-operations', {
      count,
      ...operations,
      unchangedQueries: 10
    })
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(30_001)
    await query()
    expect(f.repository.current(source).records).toEqual(records)
  }
)

it('keeps one immutable multi-piece resource publication without any subscriber, after the last subscriber, and through idle reacquisition', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  await writeFile(f.path, question('large', 'escaped \\" 😀'.repeat(10_000)))
  const read = (version: string, cursor = 0) =>
    queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      's',
      decodeCodexTranscriptLine,
      (projection) => readCurrentRequestsPiece(projection, { sessionId: 's', version, cursor }),
      undefined,
      f.repository
    )
  const opening = await read('unknown')
  expect(opening.restart).toBe(true)
  const initial = await read(opening.marker.version)
  expect(initial.nextCursor).not.toBeNull()
  const notify = vi.fn()
  const viewer = acquireTranscriptCurrentQuestions(
    f.path,
    'codex',
    's',
    decodeCodexTranscriptLine,
    notify,
    f.repository
  )
  viewer.dispose()
  let cursor = initial.nextCursor
  let bytes = initial.json
  while (cursor !== null) {
    const piece = await read(initial.marker.version, cursor)
    expect(piece.marker).toEqual(initial.marker)
    expect(piece.restart).toBeUndefined()
    bytes += piece.json
    cursor = piece.nextCursor
  }
  expect(JSON.parse(bytes).asyncQuestions[0].questions[0].options[0].label).toBe(
    'escaped \\" 😀'.repeat(10_000)
  )
  expect(notify).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_001)
  const reopened = await read(initial.marker.version)
  expect(reopened.restart).toBe(true)
  const complete = await read(reopened.marker.version)
  expect(complete.restart).toBeUndefined()
  expect(complete.marker.publisher).not.toBe(initial.marker.publisher)
  expect(
    f.repository.current({ kind: 'transcript', agent: 'codex', sessionId: 's', filePath: f.path })
      .pending
  ).toHaveLength(1)
})

it.each([40, 400])(
  'does no pending-definition work for unrelated output with %i pending calls on the real shared watcher',
  async (count) => {
    vi.useFakeTimers()
    const f = await fixture()
    await writeFile(
      f.path,
      Array.from({ length: count }, (_, i) => question(`q-${i}`, 'detail'.repeat(200))).join('')
    )
    let publication: CurrentRequestsProjection | undefined
    const appendedIds: string[][] = [[], []]
    const notify = vi.fn((next: CurrentRequestsProjection) => {
      publication = next
    })
    for (let viewer = 0; viewer < 2; viewer++) {
      const subscription = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
        agent: 'codex',
        sessionId: 's',
        initialLimit: 1,
        debounceMs: 1,
        reconciliationIntervalMs: 20,
        prepareCurrentRequests: async () => f.repository,
        onInitialSnapshot: () => {},
        onAppend: (messages) => {
          appendedIds[viewer].push(...messages.map((message) => message.id))
        },
        onCurrentRequests: (next) => notify(next)
      })
      if (!subscription) {
        throw new Error('Expected watcher')
      }
      cleanup.push(subscription.unsubscribe)
    }
    await vi.waitFor(() =>
      expect(
        publication?.items &&
          !Array.isArray(publication.items) &&
          publication.items.asyncQuestions?.length
      ).toBe(count)
    )
    await queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      's',
      decodeCodexTranscriptLine,
      () => {},
      undefined,
      f.repository
    )
    expect(notify.mock.calls.filter(([value]) => value.items === undefined)).toHaveLength(2)
    const initialPublications = notify.mock.calls.length
    const before = publication
    const saved = f.repository.current({
      kind: 'transcript',
      agent: 'codex',
      sessionId: 's',
      filePath: f.path
    })
    expect(saved.pending).toHaveLength(count)
    let definitionReads = 0
    for (const record of saved.pending) {
      const questions = record.questions
      Object.defineProperty(record, 'questions', {
        configurable: true,
        enumerable: true,
        get: () => {
          definitionReads++
          return questions
        }
      })
    }
    const serialize = vi.spyOn(JSON, 'stringify')
    const query = vi.spyOn(f.database.db, 'prepare')
    for (let i = 0; i < 3; i++) {
      await appendFile(f.path, output(`output-${i}`))
      await vi.waitFor(() =>
        appendedIds.forEach((ids) => {
          expect(ids.filter((id) => id === `output-${i}`).length).toBeGreaterThanOrEqual(1)
        })
      )
      await queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        's',
        decodeCodexTranscriptLine,
        (current) => {
          expect(
            current,
            JSON.stringify({
              before: before?.marker,
              current: current.marker,
              sameItems: current.items === before?.items,
              definitionReads,
              publications: notify.mock.calls.map(([value]) => value.marker)
            })
          ).toBe(before)
        },
        undefined,
        f.repository
      )
    }
    expect(definitionReads).toBe(0)
    expect(serialize.mock.calls.filter(([value]) => value === before?.items)).toHaveLength(0)
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT occurrence_id'))).toHaveLength(
      0
    )
    expect(notify).toHaveBeenCalledTimes(initialPublications)
    serialize.mockRestore()
    query.mockRestore()
    await appendFile(f.path, question('new-question'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(initialPublications + 2))
    expect(definitionReads).toBeGreaterThan(0)
    expect(publication).not.toBe(before)
    await appendFile(f.path, output('delivered-answer', 'user'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(initialPublications + 4))
    const payload = publication?.items
    if (!payload || Array.isArray(payload)) {
      throw new Error('Expected complete payload')
    }
    expect(payload.asyncQuestions).toEqual([])
  }
)

it.each([40, 400])(
  'retains incremental work and immutable definition bytes after a real racing read with %i pending calls',
  async (count) => {
    vi.useFakeTimers()
    const f = await fixture()
    await writeFile(
      f.path,
      Array.from({ length: count }, (_, i) => question(`race-q-${i}`)).join('')
    )
    const decode = vi.fn(decodeCodexTranscriptLine)
    const query = () =>
      queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        'race',
        decode,
        (projection) => projection,
        undefined,
        f.repository
      )
    const before = await query()
    const publications: CurrentRequestsProjection[] = []
    const initial = vi.fn()
    const history = vi.fn()
    const watcher = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
      agent: 'codex',
      sessionId: 'race',
      initialLimit: 1,
      debounceMs: 1,
      reconciliationIntervalMs: 20,
      prepareCurrentRequests: async () => f.repository,
      onInitialSnapshot: initial,
      onAppend: history,
      onCurrentRequests: (projection) => publications.push(projection)
    })
    if (!watcher) {
      throw new Error('Expected real watcher')
    }
    cleanup.push(watcher.unsubscribe)
    await vi.waitFor(() => expect(initial).toHaveBeenCalledTimes(1))
    expect(await query()).toBe(before)
    decode.mockClear()
    publications.length = 0
    const ingest = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const reconcile = vi.spyOn(f.repository, 'reconcile')
    const serialize = vi.spyOn(JSON, 'stringify')
    const originalVersion = fileVersions.readTranscriptFileVersion
    let versions = 0
    vi.spyOn(fileVersions, 'readTranscriptFileVersion').mockImplementation(async (...args) => {
      if (++versions === 2) {
        await appendFile(f.path, output('raced-after-read'))
      }
      return originalVersion(...args)
    })
    await appendFile(f.path, output('ordinary-before-race'))
    const recovered = await query()
    expect(recovered).toBe(before)
    expect(recovered.items).toBe(before.items)
    expect(decode).toHaveBeenCalledTimes(2)
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(reconcile).toHaveBeenCalledTimes(1)
    const definitionSerializations = () =>
      serialize.mock.calls.filter(
        ([value]) =>
          value !== null &&
          typeof value === 'object' &&
          ('responseMode' in value || 'asyncQuestions' in value)
      ).length
    expect(definitionSerializations()).toBe(0)
    expect(publications).toHaveLength(0)
    const operations = {
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      repository: reconcile.mock.calls.length,
      definitionSerializations: definitionSerializations()
    }
    for (let i = 0; i < 10; i++) {
      expect(await query()).toBe(recovered)
    }
    expect({
      decoder: decode.mock.calls.length,
      ingest: ingest.mock.calls.length,
      repository: reconcile.mock.calls.length,
      definitionSerializations: definitionSerializations()
    }).toEqual(operations)
    await vi.waitFor(() =>
      expect(
        history.mock.calls.flatMap(([messages]) => messages.map((message) => message.id))
      ).toEqual(['ordinary-before-race', 'raced-after-read'])
    )
    expect(decode).toHaveBeenCalledTimes(2)
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(publications).toHaveLength(0)
    console.log('question-terminal-race-operations', { count, ...operations, unchangedQueries: 10 })
  }
)

it('cancels only displayed IDs through the source owner and preserves native terminal outcomes on edited replay', async () => {
  const f = await fixture()
  await writeFile(f.path, question('q1'))
  const current = () =>
    queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      's',
      decodeCodexTranscriptLine,
      (projection) => {
        if (Array.isArray(projection.items)) {
          throw new Error('Expected occurrence payload')
        }
        return projection.items.asyncQuestions
      },
      undefined,
      f.repository
    )
  const displayed = await current()
  await appendFile(f.path, question('q2'))
  await cancelTranscriptCurrentQuestions(
    f.path,
    'codex',
    's',
    decodeCodexTranscriptLine,
    displayed.map((row) => row.id),
    'phone',
    10,
    undefined,
    f.repository
  )
  expect((await current()).map((row) => row.sourceRowId)).toEqual(['q2'])
  await writeFile(f.path, question('q1', 'Edited after Cancel') + question('q2') + question('q3'))
  expect((await current()).map((row) => row.sourceRowId)).toEqual(['q2', 'q3'])
  const saved = f.repository.current({
    kind: 'transcript',
    agent: 'codex',
    sessionId: 's',
    filePath: f.path
  }).records
  expect(saved.find((row) => row.id === displayed[0].id)).toMatchObject({
    questions: [{ options: [{ label: 'Edited after Cancel' }, { label: 'Red' }] }],
    resolution: { state: 'cancelled', reason: 'user' }
  })
  await appendFile(f.path, output('delivered', 'user'))
  await cancelTranscriptCurrentQuestions(
    f.path,
    'codex',
    's',
    decodeCodexTranscriptLine,
    [displayed[0].id],
    'phone',
    20,
    undefined,
    f.repository
  )
  expect(await current()).toEqual([])
})
