import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
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

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const release of cleanup.toReversed()) {
    await release()
  }
  cleanup.length = 0
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-question-source-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const database = JournalHostDatabase.open(join(root, 'host'))
  cleanup.push(() => database.close())
  return { path: join(root, 'rollout.jsonl'), repository: messageQuestionsFor(database), database }
}
function question(id: string, detail = 'A choice') {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      id,
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: id,
      arguments: JSON.stringify({
        questions: [{ title: 'Which color?', options: [detail, 'Red'] }]
      })
    }
  })}\n`
}
function output(id: string, role = 'assistant') {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      id,
      type: 'message',
      role,
      content: [{ type: 'text', text: role === 'user' ? 'Blue' : 'Still working' }]
    }
  })}\n`
}

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
    const f = await fixture()
    await writeFile(
      f.path,
      Array.from({ length: count }, (_, i) => question(`q-${i}`, 'detail'.repeat(200))).join('')
    )
    let publication: CurrentRequestsProjection | undefined
    let appends = 0
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
        onAppend: () => {
          appends++
        },
        onCurrentRequests: (next) => notify(next)
      })
      if (!subscription) {
        throw new Error('Expected watcher')
      }
      cleanup.push(subscription.unsubscribe)
    }
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
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
      await vi.waitFor(() => expect(appends).toBe((i + 1) * 2))
      await queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        's',
        decodeCodexTranscriptLine,
        (current) => {
          expect(current).toBe(before)
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
    expect(notify).toHaveBeenCalledTimes(2)
    serialize.mockRestore()
    query.mockRestore()
    await appendFile(f.path, question('new-question'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(4))
    expect(definitionReads).toBeGreaterThan(0)
    expect(publication).not.toBe(before)
    await appendFile(f.path, output('delivered-answer', 'user'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(6))
    const payload = publication?.items
    if (!payload || Array.isArray(payload)) {
      throw new Error('Expected complete payload')
    }
    expect(payload.asyncQuestions).toEqual([])
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

it('keeps history usable after occurrence setup fails and retries on unchanged-file reconciliation', async () => {
  const f = await fixture()
  await writeFile(f.path, question('pending-through-store-recovery'))
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(new Error('Store temporarily unavailable'))
    .mockResolvedValue(f.repository)
  const snapshot = vi.fn()
  const notify = vi.fn()
  const subscription = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 's',
    initialLimit: 1,
    debounceMs: 1,
    reconciliationIntervalMs: 20,
    prepareCurrentRequests: prepare,
    onInitialSnapshot: snapshot,
    onAppend: () => {},
    onCurrentRequests: notify
  })
  if (!subscription) {
    throw new Error('Expected watcher')
  }
  cleanup.push(subscription.unsubscribe)
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2)
  const publication = notify.mock.calls[0][0]
  if (Array.isArray(publication.items)) {
    throw new Error('Expected complete occurrence payload')
  }
  expect(publication.items.asyncQuestions.map((record) => record.sourceRowId)).toEqual([
    'pending-through-store-recovery'
  ])
})

it('never publishes a complete set past failed creation and recovers on unchanged-file watcher reconciliation', async () => {
  const f = await fixture()
  await writeFile(f.path, question('q1'))
  const notify = vi.fn()
  const subscription = acquireTranscriptCurrentQuestions(
    f.path,
    'codex',
    's',
    decodeCodexTranscriptLine,
    notify,
    f.repository
  )
  cleanup.push(subscription.dispose)
  await subscription.refresh()
  expect(notify).toHaveBeenCalledTimes(1)
  await appendFile(f.path, question('q2'))
  const fail = vi.spyOn(f.database, 'transaction').mockImplementation(() => {
    throw new Error('creation failed')
  })
  await expect(subscription.refresh()).rejects.toThrow('creation failed')
  expect(notify).toHaveBeenCalledTimes(1)
  await expect(
    queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      's',
      decodeCodexTranscriptLine,
      (projection) => projection,
      undefined,
      f.repository
    )
  ).rejects.toThrow('creation failed')
  expect(notify).toHaveBeenCalledTimes(1)
  fail.mockRestore()
  const watched = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 's',
    initialLimit: 1,
    debounceMs: 1,
    reconciliationIntervalMs: 20,
    prepareCurrentRequests: async () => f.repository,
    onInitialSnapshot: () => {},
    onAppend: () => {},
    onCurrentRequests: notify
  })
  if (!watched) {
    throw new Error('Expected watcher')
  }
  cleanup.push(watched.unsubscribe)
  await vi.waitFor(() => {
    const latest = notify.mock.calls.at(-1)?.[0]
    if (!latest || Array.isArray(latest.items)) {
      throw new Error('Expected complete publication')
    }
    expect(latest.items.asyncQuestions.map((record) => record.sourceRowId)).toEqual(['q1', 'q2'])
  })
})

it('aborts an in-flight source refresh before authoritative deletion removes durable linkage', async () => {
  const f = await fixture()
  await writeFile(f.path, question('q1'))
  const notify = vi.fn()
  const subscription = acquireTranscriptCurrentQuestions(
    f.path,
    'codex',
    's',
    decodeCodexTranscriptLine,
    notify,
    f.repository
  )
  cleanup.push(subscription.dispose)
  await subscription.refresh()
  await appendFile(f.path, question('q2'))
  const readVersion = fileVersions.readTranscriptFileVersion
  let resume: () => void = () => {}
  let reachedCommit = false
  const blocked = new Promise<void>((resolve) => {
    resume = resolve
  })
  let reads = 0
  vi.spyOn(fileVersions, 'readTranscriptFileVersion').mockImplementation(async (...args) => {
    const version = await readVersion(...args)
    if (++reads === 3) {
      reachedCommit = true
      await blocked
    }
    return version
  })
  const inflight = subscription.refresh()
  const settled = expect(inflight).rejects.toThrow()
  await vi.waitFor(() => expect(reachedCommit).toBe(true))
  // The existing owner has removed the file; release live source before the linkage transaction.
  await rm(f.path)
  f.repository.deleteTranscriptSources('codex', f.path)
  resume()
  await settled
  await expect(subscription.refresh()).rejects.toThrow()
  expect(notify).toHaveBeenCalledTimes(1)
  const source = { kind: 'transcript' as const, agent: 'codex', sessionId: 's', filePath: f.path }
  expect(f.repository.current(source).records).toEqual([])
  expect(f.database.db.prepare('SELECT source_id FROM message_question_sources').all()).toEqual([])
})
