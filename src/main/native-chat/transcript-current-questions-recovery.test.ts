import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import {
  readCurrentRequestsPiece,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import {
  acquireTranscriptCurrentQuestions,
  queryTranscriptCurrentQuestions
} from './transcript-current-questions'
import * as fileVersions from './transcript-file-version'
import * as wsl from '../wsl'
import * as transcriptFs from './wsl-transcript-fs-access'
import * as questionSources from './transcript-question-source'
import * as currentQuestions from './transcript-current-questions'
import * as runningObserver from './wsl-transcript-running-observer'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { installTranscriptWatcher } from './transcript-watch-engine'
import { createNativeChatCurrentRequestsBinding } from '../../shared/native-chat-current-requests-binding'
import {
  currentMessageQuestionView,
  type AgentSessionCurrentRequestsState
} from '../../shared/agent-session-current-requests'
import { cleanup, fixture, question } from './transcript-current-questions-test-fixture'

it('keeps one capable marker through cold preparation failure and recovers both client bindings on unchanged-source reconciliation', async () => {
  const f = await fixture()
  await writeFile(f.path, question('cold'))
  let unavailable = true
  const states: AgentSessionCurrentRequestsState[] = [{}, {}]
  const publications: CurrentRequestsProjection[] = []
  const bindings = states.map((_state, index) =>
    createNativeChatCurrentRequestsBinding({
      read: (request, signal) =>
        queryTranscriptCurrentQuestions(
          f.path,
          'codex',
          's',
          decodeCodexTranscriptLine,
          (projection) => readCurrentRequestsPiece(projection, request),
          signal,
          f.repository
        ),
      publish: (state) => {
        states[index] = state
      }
    })
  )
  cleanup.push(() => bindings.forEach((binding) => binding.invalidate()))
  let initialHistory = false
  const prepare = vi.fn(async () => {
    if (unavailable) {
      throw new Error('Question database temporarily unavailable')
    }
    return f.repository
  })
  const watcher = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 's',
    initialLimit: 1,
    reconciliationIntervalMs: 20,
    prepareCurrentRequests: prepare,
    onInitialSnapshot: (messages) => {
      initialHistory = messages.length > 0
    },
    onAppend: () => {},
    onCurrentRequests: (projection) => {
      publications.push(projection)
      bindings.forEach((binding) =>
        binding.observe({ type: 'appended', currentRequests: projection.marker })
      )
    }
  })
  if (!watcher) {
    throw new Error('Expected watcher')
  }
  cleanup.push(watcher.unsubscribe)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled())
  expect(initialHistory).toBe(true)
  const unknown = publications[0]
  expect(unknown.items).toBeUndefined()
  states.forEach((state) =>
    expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: false })
  )
  await expect(
    queryTranscriptCurrentQuestions(
      f.path,
      'codex',
      's',
      decodeCodexTranscriptLine,
      (projection) =>
        readCurrentRequestsPiece(projection, { sessionId: 's', version: unknown.marker.version }),
      undefined,
      f.repository
    )
  ).rejects.toThrow('Current questions temporarily unavailable')
  expect(publications.every((projection) => projection === unknown)).toBe(true)
  unavailable = false
  await vi.waitFor(() =>
    states.forEach((state) => {
      expect(currentMessageQuestionView(state)?.ready).toBe(true)
      expect(state.asyncQuestions).toHaveLength(1)
    })
  )
  expect(publications.at(-1)?.marker.publisher).toBe(unknown.marker.publisher)
  expect(publications.at(-1)?.items).toBeDefined()
})

it('publishes verified null after materialization failure, retains disabled controls and retries without new bytes', async () => {
  const f = await fixture()
  await writeFile(f.path, question('q1'))
  const states: AgentSessionCurrentRequestsState[] = [{}, {}]
  const publications: CurrentRequestsProjection[] = []
  const bindings = states.map((_state, index) =>
    createNativeChatCurrentRequestsBinding({
      read: (request, signal) =>
        queryTranscriptCurrentQuestions(
          f.path,
          'codex',
          's',
          decodeCodexTranscriptLine,
          (projection) => readCurrentRequestsPiece(projection, request),
          signal,
          f.repository
        ),
      publish: (state) => {
        states[index] = state
      }
    })
  )
  cleanup.push(() => bindings.forEach((binding) => binding.invalidate()))
  const watcher = await installTranscriptWatcher(f.path, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 's',
    initialLimit: 1,
    debounceMs: 1,
    reconciliationIntervalMs: 20,
    prepareCurrentRequests: async () => f.repository,
    onInitialSnapshot: () => {},
    onAppend: () => {},
    onCurrentRequests: (projection) => {
      publications.push(projection)
      bindings.forEach((binding) =>
        binding.observe({ type: 'appended', currentRequests: projection.marker })
      )
    }
  })
  if (!watcher) {
    throw new Error('Expected watcher')
  }
  cleanup.push(watcher.unsubscribe)
  await vi.waitFor(() =>
    states.forEach((state) => expect(currentMessageQuestionView(state)?.ready).toBe(true))
  )
  const retained = states[0].asyncQuestions
  f.database.db.exec(
    "CREATE TEMP TRIGGER fail_async_creation BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated async creation failure'); END"
  )
  try {
    await appendFile(f.path, question('q2'))
    await vi.waitFor(() =>
      states.forEach((state) => {
        expect(currentMessageQuestionView(state)?.ready).toBe(false)
        expect(state.asyncQuestions).toEqual(retained)
      })
    )
    const unknown = publications.at(-1)!
    expect(unknown.items && !Array.isArray(unknown.items) && unknown.items.asyncQuestions).toBe(
      null
    )
    const attempts = vi.spyOn(f.repository, 'reconcile')
    const decode = vi.fn(decodeCodexTranscriptLine)
    for (let i = 0; i < 10; i++) {
      await queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        's',
        decode,
        (projection) => expect(projection).toBe(unknown),
        undefined,
        f.repository
      )
    }
    expect(decode).not.toHaveBeenCalled()
    expect(publications.at(-1)).toBe(unknown)
    expect(attempts).toHaveBeenCalled()
  } finally {
    f.database.db.exec('DROP TRIGGER fail_async_creation')
  }
  await vi.waitFor(() =>
    states.forEach((state) => {
      expect(currentMessageQuestionView(state)?.ready).toBe(true)
      expect(state.asyncQuestions).toHaveLength(2)
    })
  )
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
  await vi.waitFor(() => expect(notify.mock.calls.at(-1)?.[0].items).toBeDefined())
  expect(notify.mock.calls[0][0].items).toBeUndefined()
  expect(notify).toHaveBeenCalledTimes(2)
  expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2)
  const publication = notify.mock.calls.at(-1)![0]
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
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify.mock.calls[0][0].items).toBeUndefined()
  expect(notify.mock.calls[1][0].items.asyncQuestions).toHaveLength(1)
  await appendFile(f.path, question('q2'))
  const fail = vi.spyOn(f.database, 'transaction').mockImplementation(() => {
    throw new Error('creation failed')
  })
  await expect(subscription.refresh()).rejects.toThrow('creation failed')
  expect(notify).toHaveBeenCalledTimes(3)
  expect(notify.mock.calls.at(-1)![0].items.asyncQuestions).toBeNull()
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
  ).resolves.toMatchObject({ items: { asyncQuestions: null } })
  expect(notify).toHaveBeenCalledTimes(3)
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
  expect(notify).toHaveBeenCalledTimes(2)
  const source = { kind: 'transcript' as const, agent: 'codex', sessionId: 's', filePath: f.path }
  expect(f.repository.current(source).records).toEqual([])
  expect(f.database.db.prepare('SELECT source_id FROM message_question_sources').all()).toEqual([])
})

it('recovers cold and established unknown through the actual running-WSL observer without bytes, agent activity or source-query advancement', async () => {
  const f = await fixture()
  await writeFile(f.path, question('wsl-q1'))
  const origin = new AsyncLocalStorage<{ wake?: number; operation?: number }>()
  const operations: { wake?: number; settled: boolean; failed: boolean; recovered: boolean }[] = []
  const publicationOrigins = new Map<
    CurrentRequestsProjection,
    ReturnType<typeof origin.getStore>
  >()
  let nextWake = 0
  let storageRestored = false
  const observe = runningObserver.observeWslTranscriptRunningState
  vi.spyOn(runningObserver, 'observeWslTranscriptRunningState').mockImplementation(
    (path, onRunning, onStopped) =>
      observe(path, () => origin.run({ wake: ++nextWake }, onRunning), onStopped)
  )
  const create = questionSources.createTranscriptQuestionSource
  vi.spyOn(questionSources, 'createTranscriptQuestionSource').mockImplementation((...args) => {
    const source = create(...args)
    const refresh = source.refresh
    vi.spyOn(source, 'refresh').mockImplementation(() => {
      const operation = {
        wake: origin.getStore()?.wake,
        settled: false,
        failed: false,
        recovered: false
      }
      const index = operations.push(operation) - 1
      const actual = origin.run({ wake: operation.wake, operation: index }, refresh)
      void actual.then(
        () => {
          operation.settled = true
          operation.recovered = storageRestored
        },
        () => {
          operation.settled = true
          operation.failed = true
        }
      )
      return actual
    })
    return source
  })
  const queries = vi.spyOn(currentQuestions, 'queryTranscriptCurrentQuestions')
  const unc = '\\\\wsl.localhost\\Ubuntu\\home\\qa\\rollout.jsonl'
  // Only the remote filesystem is adapted; watcher, distro observer, source and bindings are real.
  const stat = transcriptFs.transcriptFileStat
  const open = transcriptFs.openTranscriptFile
  const read = transcriptFs.readTranscriptFile
  const close = transcriptFs.closeTranscriptHandle
  const stream = transcriptFs.openTranscriptReadStream
  const slice = transcriptFs.readTranscriptSlice
  const local = (path: string) => (path === unc ? f.path : path)
  vi.spyOn(transcriptFs, 'transcriptFileStat').mockImplementation((path, ...args) =>
    stat(local(path), ...args)
  )
  vi.spyOn(transcriptFs, 'openTranscriptFile').mockImplementation((path, ...args) =>
    open(local(path), ...args)
  )
  vi.spyOn(transcriptFs, 'readTranscriptFile').mockImplementation((handle, path, ...args) =>
    read(handle, local(path), ...args)
  )
  vi.spyOn(transcriptFs, 'closeTranscriptHandle').mockImplementation((handle, path) =>
    close(handle, local(path))
  )
  vi.spyOn(transcriptFs, 'openTranscriptReadStream').mockImplementation((path, ...args) =>
    stream(local(path), ...args)
  )
  vi.spyOn(transcriptFs, 'readTranscriptSlice').mockImplementation((path, ...args) =>
    slice(local(path), ...args)
  )
  const running = vi.spyOn(wsl, 'listRunningWslDistrosAsync').mockResolvedValue(['Ubuntu'])
  let unavailable = true
  let current: CurrentRequestsProjection | undefined
  const publications: CurrentRequestsProjection[] = []
  const states: AgentSessionCurrentRequestsState[] = [{}, {}]
  const bindings = states.map((_state, index) =>
    createNativeChatCurrentRequestsBinding({
      read: async (request) => {
        if (!current) {
          throw new Error('No current source publication')
        }
        return readCurrentRequestsPiece(current, request)
      },
      publish: (state) => {
        states[index] = state
      }
    })
  )
  cleanup.push(() => bindings.forEach((binding) => binding.invalidate()))
  const history = vi.fn()
  const watcher = await installTranscriptWatcher(unc, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 's',
    initialLimit: 1,
    debounceMs: 1,
    prepareCurrentRequests: async () => {
      if (unavailable) {
        throw new Error('Occurrence preparation unavailable')
      }
      return f.repository
    },
    onInitialSnapshot: history,
    onAppend: () => {},
    onCurrentRequests: (projection) => {
      current = projection
      publications.push(projection)
      publicationOrigins.set(projection, origin.getStore())
      bindings.forEach((binding) =>
        binding.observe({ type: 'appended', currentRequests: projection.marker })
      )
    }
  })
  if (!watcher) {
    throw new Error('Expected WSL watcher')
  }
  cleanup.push(watcher.unsubscribe)
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1))
  expect(current?.items).toBeUndefined()
  const publisher = current!.marker.publisher
  unavailable = false
  await vi.waitFor(
    () => states.forEach((state) => expect(currentMessageQuestionView(state)?.ready).toBe(true)),
    { timeout: 6_000 }
  )
  expect(running).toHaveBeenCalled()
  expect(current!.marker.publisher).toBe(publisher)
  const retained = states[0].asyncQuestions
  f.database.db.exec(
    "CREATE TEMP TRIGGER fail_async_creation BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated async creation failure'); END"
  )
  try {
    await appendFile(f.path, question('wsl-q2'))
    await vi.waitFor(
      () =>
        states.forEach((state) => {
          expect(currentMessageQuestionView(state)?.ready).toBe(false)
          expect(state.asyncQuestions).toEqual(retained)
        }),
      { timeout: 6_000 }
    )
    expect(current!.items && !Array.isArray(current!.items) && current!.items.asyncQuestions).toBe(
      null
    )
    const unchanged = current
    const observed = operations.length
    await vi.waitFor(
      () =>
        expect(
          operations
            .slice(observed)
            .some(
              (operation) => operation.wake !== undefined && operation.settled && operation.failed
            )
        ).toBe(true),
      { timeout: 6_000 }
    )
    expect(current).toBe(unchanged)
  } finally {
    f.database.db.exec('DROP TRIGGER fail_async_creation')
    storageRestored = true
  }
  await vi.waitFor(
    () => {
      states.forEach((state) => {
        expect(currentMessageQuestionView(state)?.ready).toBe(true)
        expect(state.asyncQuestions).toHaveLength(2)
      })
      const recovered = current && publicationOrigins.get(current)
      expect(recovered?.wake).toBeGreaterThan(0)
      expect(recovered?.operation).toBeDefined()
      expect(operations[recovered!.operation!]).toMatchObject({
        wake: recovered!.wake,
        settled: true,
        failed: false,
        recovered: true
      })
    },
    { timeout: 6_000 }
  )
  expect(current!.marker.publisher).toBe(publisher)
  expect(publications).toHaveLength(4)
  expect(
    publications.map((projection) =>
      projection.items === undefined
        ? 'unknown'
        : !Array.isArray(projection.items) && projection.items.asyncQuestions === null
          ? 'null'
          : 'complete'
    )
  ).toEqual(['unknown', 'complete', 'null', 'complete'])
  expect(queries).not.toHaveBeenCalled()
  watcher.unsubscribe()
}, 30_000)
