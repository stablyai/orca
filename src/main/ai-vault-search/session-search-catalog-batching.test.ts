import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import { SessionSearchCatalog } from './session-search-catalog'
import type { SessionSearchCatalogCommand } from './session-search-catalog'
import { createSessionSearchJsonlDependency } from './session-search-jsonl-dependency'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './indexing/session-search-indexer-test-fixture'
import { SessionSearchWorkerClient } from './worker/session-search-worker-client'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import { SessionSearchWorkerStore } from './worker/session-search-worker-store'
import { SessionSearchWorkQueue } from './session-search-work-queue'
import { configureSessionSearchWorkerFixture } from './worker/session-search-worker.test-fixture'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

it.each([40, 400])(
  'batches discovery and replacement metadata for %s retained files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-catalog-pages')
    const db = new SyncDatabase('')
    const catalog = new SessionSearchCatalog(db)
    let transactions = 0
    const exec = db.exec.bind(db)
    const transactionTraffic = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql.startsWith('SAVEPOINT ')) {
        transactions++
      }
      return exec(sql)
    })
    let envelopes = 0,
      localRows = 0
    let invalidEnvelope:
      | { kind: SessionSearchCatalogCommand['kind']; requestBytes: number; resultBytes: number }
      | undefined
    const execute = catalog.execute.bind(catalog)
    const local = vi.spyOn(catalog, 'execute').mockImplementation((command) => {
      const result = execute(command)
      localRows +=
        command.kind === 'put'
          ? command.rows.length
          : command.kind === 'get'
            ? 1
            : command.kind === 'page'
              ? (result.rows?.length ?? 0)
              : 0
      return result
    })
    const request = async (command: SessionSearchCatalogCommand) => {
      envelopes++
      const result = catalog.response(command)
      const requestBytes = JSON.stringify(command).length * 2
      const resultBytes = JSON.stringify(result).length * 2
      if (!invalidEnvelope && (requestBytes > 256 * 1024 || resultBytes > 256 * 1024)) {
        invalidEnvelope = { kind: command.kind, requestBytes, resultBytes }
      }
      return result
    }
    const root = join(harness.root, 'inputs')
    const inventory = new SessionFileInventory(root, request, 'physical:batch-control')
    const args: DiscoverSessionFilesArgs = {
      rootDir: root,
      agent: 'claude',
      limit: 0,
      issues: [],
      extensions: ['.jsonl']
    }
    const drain = async () => {
      const paths: string[] = []
      while (inventory.pending) {
        await inventory.retryFailures()
        const delta = await inventory.drain(args, () => false, 0)
        paths.push(...delta.changes.map(({ file }) => file.path))
        await inventory.acknowledge(delta.receipts)
      }
      return paths
    }
    const check = () => {
      // A single directory has fixed phase transitions; each page needs staging, preparation and acceptance, independent of its member count.
      const pages = Math.ceil(population / 256)
      expect(envelopes).toBeLessThanOrEqual(40 + 12 * pages)
      // A bounded command can accept an input receipt and an owner page inside its outer transaction.
      expect(transactions).toBeLessThanOrEqual(3 * (40 + 12 * pages))
      // Required comparisons and accepted observations visit each input only a fixed number of times locally.
      expect(localRows).toBeLessThanOrEqual(30 * population + 100)
      expect(invalidEnvelope).toBeUndefined()
    }
    const unclaimed = () => {
      for (const suffix of ['authority', 'authority-garbage']) {
        expect(execute({ kind: 'count', scope: `physical:batch-control:${suffix}` }).count).toBe(0)
      }
    }
    const reset = () => {
      envelopes = 0
      localRows = 0
      transactions = 0
      invalidEnvelope = undefined
      local.mockClear()
    }
    try {
      await mkdir(root)
      for (let index = 0; index < population; index++) {
        await writeFile(join(root, `${index}.jsonl`), '{}\n')
      }
      await inventory.begin(false, args)
      expect(await drain()).toHaveLength(population)
      check()
      unclaimed()
      reset()
      await inventory.reconcile()
      expect(await drain()).toEqual([])
      check()
      reset()
      await inventory.invalidate(root)
      expect(await drain()).toEqual([])
      check()
      unclaimed()
      const metadata = join(harness.root, 'titles.jsonl')
      const observer = createSessionSearchJsonlDependency(
        metadata,
        (line) => {
          const [id, title] = line.split(':')
          return id && title ? [id, title] : null
        },
        { request, scope: 'metadata:batch-control' }
      )
      const values = async () => {
        const keys: string[] = []
        for await (const key of await observer(false)) {
          keys.push(key)
        }
        return keys
      }
      await writeFile(
        metadata,
        `${Array.from({ length: population }, (_, index) => `${index}:before`).join('\n')}\n`
      )
      reset()
      expect(await values()).toHaveLength(population)
      check()
      await writeFile(
        metadata,
        `${Array.from({ length: population }, (_, index) => `${index}:after!`).join('\n')}\n`
      )
      reset()
      expect(await values()).toHaveLength(population)
      check()
      reset()
      expect(await values()).toEqual([])
      expect(envelopes).toBe(0)
    } finally {
      transactionTraffic.mockRestore()
      local.mockRestore()
      db.close()
      await harness.cleanup()
    }
  }
)

it.each([40, 400])(
  'searches the newest known transcript before an older candidate page at %s files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-newest-page')
    const clock = new FakeSessionSearchClock()
    clock.costPerNowMs = 1000
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      passDeadlineMs: 1000,
      discoveryDeadlineMs: Infinity
    })
    try {
      for (let index = 0; index < population; index++) {
        const path = join(harness.claudeProjectDir, `${String(index).padStart(3, '0')}.jsonl`)
        await writeClaudeTranscript(
          path,
          [index === population - 1 ? 'newestknownneedle' : 'olderknownneedle'],
          `session-${index}`
        )
        const time = new Date(index === population - 1 ? '2025-01-02' : '2025-01-01')
        await utimes(path, time, time)
      }
      await subject.start()
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'newestknownneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'olderknownneedle'"
            )
            .get()
        )
      ).toEqual({ n: 0 })
    } finally {
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('redelivers an unaccepted observation and retains a newer rewrite after an older acknowledgement', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-observation-ack')
  const db = new SyncDatabase('')
  const catalog = new SessionSearchCatalog(db)
  const root = join(harness.root, 'inputs')
  const path = join(root, 'conversation.jsonl')
  let refuseApply = true
  const inventory = new SessionFileInventory(
    root,
    async (command) => {
      if (refuseApply && command.kind === 'observe-apply') {
        refuseApply = false
        throw new Error('fixture rejected observation publication')
      }
      return catalog.response(command)
    },
    'physical:receipt-control'
  )
  const args: DiscoverSessionFilesArgs = {
    rootDir: root,
    agent: 'claude',
    limit: 0,
    issues: [],
    extensions: ['.jsonl']
  }
  const time = new Date('2025-01-01')
  try {
    await mkdir(root)
    await writeFile(path, 'before\n')
    await utimes(path, time, time)
    await expect(inventory.drain(args, () => false, 0)).rejects.toThrow(
      'fixture rejected observation publication'
    )
    const initial = await inventory.drain(args, () => false, 0)
    expect(
      db
        .prepare('SELECT count(*) AS n FROM temp.search_catalog WHERE scope=?')
        .get('physical:receipt-control:observation-epochs')
    ).toEqual({ n: 0 })
    expect(initial.changes.map(({ file }) => file.path)).toEqual([path])
    // The first downstream consumer fails before accepting its page.
    expect(
      (await inventory.drain(args, () => false, 0)).changes.map(({ file }) => file.path)
    ).toEqual([path])
    await writeFile(path, 'after!\n')
    await utimes(path, time, time)
    await inventory.invalidate(path)
    const newer = await inventory.drain(args, () => false, 0)
    await inventory.acknowledge(initial.receipts)
    expect((await inventory.drain(args, () => false, 0)).changes).toMatchObject([
      { file: { path }, force: true }
    ])
    await inventory.acknowledge(newer.receipts)
    expect((await inventory.drain(args, () => false, 0)).changes).toEqual([])
  } finally {
    db.close()
    await harness.cleanup()
  }
})

it.each([40, 400])(
  'batches child scheduling and bounds cancellation for %s directories',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-directory-pages')
    const db = new SyncDatabase('')
    const catalog = new SessionSearchCatalog(db)
    const root = join(harness.root, 'inputs')
    let envelopes = 0
    const cancelled: number[] = []
    const inventory = new SessionFileInventory(
      root,
      async (command) => {
        envelopes++
        const result = catalog.response(command)
        if (command.kind === 'directory-cancel-step') {
          cancelled.push(result.processed ?? 0)
        }
        return result
      },
      'physical:directory-control'
    )
    const args: DiscoverSessionFilesArgs = {
      rootDir: root,
      agent: 'claude',
      limit: 0,
      issues: [],
      extensions: ['.jsonl']
    }
    const listings = vi.spyOn(filesystem, 'wslGatedReaddir')
    try {
      for (let n = 0; n < population; n++) {
        await mkdir(join(root, `child-${n}`), { recursive: true })
      }
      await inventory.drain(
        args,
        () => listings.mock.calls.some(([path]) => path.startsWith(`${root}/`)),
        0
      )
      // Root load, comparison and scheduling use a fixed set of phases per entry page; one active child adds fixed work.
      expect(envelopes).toBeLessThanOrEqual(60 + 8 * Math.ceil(population / 256))
      await rm(root, { recursive: true })
      await inventory.invalidate(root)
      listings.mockClear()
      // Each retained directory has cancellation, removal and completion phases, with no descendant source reads.
      for (let cycle = 0; cycle < 6 * (population + 1) + 10 && inventory.pending; cycle++) {
        await inventory.retryFailures()
        const delta = await inventory.drain(args, () => true, 0)
        await inventory.acknowledge(delta.receipts)
      }
      expect(inventory.pending).toBe(false)
      expect(listings.mock.calls.filter(([path]) => path.startsWith(`${root}/`))).toHaveLength(0)
      expect(cancelled.length).toBeGreaterThan(0)
      expect(Math.max(...cancelled)).toBeLessThanOrEqual(256)
    } finally {
      listings.mockRestore()
      db.close()
      await harness.cleanup()
    }
  }
)

it.each([40, 400])(
  'releases a removed %s-file source through bounded bookkeeping pages',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-release-pages')
    const clock = new FakeSessionSearchClock()
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
    const matches = () =>
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'releasedsourceneedle'"
          )
          .get()
      )
    try {
      for (let n = 0; n < population; n++) {
        await writeClaudeTranscript(
          join(harness.claudeProjectDir, `${n}.jsonl`),
          ['releasedsourceneedle'],
          `session-${n}`
        )
      }
      await subject.start()
      expect(matches()).toEqual({ n: 2 * population })
      await rm(harness.claudeProjectDir, { recursive: true })
      await mkdir(harness.claudeProjectDir)
      const next = join(harness.root, 'next-projects')
      await mkdir(next)
      harness.roots.claudeProjectsDir = next
      traffic.mockClear()
      await subject.reconcile({ full: true })
      await subject.reconcile()
      expect(matches()).toEqual({ n: 0 })
      expect(subject.status().phase).toBe('current')
      const bookkeeping = traffic.mock.calls.filter(
        ([command]) =>
          command.op === 'sync' ||
          command.op === 'catalog' ||
          command.op === 'candidates' ||
          command.op === 'work' ||
          command.op === 'coverage' ||
          command.op === 'file-page'
      )
      // Source release, queue/retirement admission and coverage use fixed phases per page; actual content deletes are separate required output.
      expect(bookkeeping.length).toBeLessThanOrEqual(200 + 64 * Math.ceil(population / 256))
    } finally {
      traffic.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each([40, 400])(
  'searches a new change and owed history in the same limited pass with %s changes',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-read-fairness')
    const clock = new FakeSessionSearchClock()
    clock.costPerNowMs = 1000
    harness.roots.claudeProjectsDir = join(
      harness.root,
      ...Array.from({ length: 8 }, () => 'p'.repeat(90)),
      'claude-projects'
    )
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      passDeadlineMs: 2000,
      discoveryDeadlineMs: Infinity,
      fullSweepEveryCycles: 1000
    })
    const directory = join(harness.roots.claudeProjectsDir!, 'project')
    const hits = () =>
      harness.read((db) =>
        db
          .prepare(`SELECT DISTINCT s.session_id AS id FROM messages_fts
          JOIN messages m ON m.id=messages_fts.rowid
          JOIN sessions s ON s.id=m.session_row_id
          WHERE messages_fts MATCH 'fairnessneedle' ORDER BY s.session_id`)
          .all()
      )
    try {
      for (let index = 0; index < 3; index++) {
        const path = join(directory, `backlog-${index}.jsonl`)
        await writeClaudeTranscript(path, ['fairnessneedle'], `backlog-${index}`)
        const time = new Date(Date.UTC(2024, 0, 1) - index * 1000)
        await utimes(path, time, time)
      }
      await subject.start()
      expect(hits()).toEqual([{ id: 'backlog-0' }, { id: 'backlog-1' }])
      for (let index = 0; index < population; index++) {
        const path = join(directory, `changed-${String(index).padStart(3, '0')}.jsonl`)
        await writeClaudeTranscript(path, ['fairnessneedle'], `changed-${index}`)
        const time = new Date(Date.UTC(2025, 0, 1) + index * 1000)
        await utimes(path, time, time)
      }
      await subject.reconcile()
      expect(hits()).toEqual([
        { id: 'backlog-0' },
        { id: 'backlog-1' },
        { id: 'backlog-2' },
        { id: `changed-${population - 1}` }
      ])
    } finally {
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each([40, 400])(
  'preserves ranked read obligations across bounded pages for %s candidates',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-read-pages')
    const store = new SessionSearchWorkerStore(harness.databasePath, (error) => {
      throw error
    })
    const queue = new SessionSearchWorkQueue()
    queue.attach(store)
    const traffic = vi.spyOn(SessionSearchWorkerClient.prototype, 'request')
    const candidates: SessionFileCandidate[] = []
    let largestResponse = 0
    configureSessionSearchWorkerFixture({
      prelude: '',
      data: undefined,
      onResponse: (response) => {
        largestResponse = Math.max(largestResponse, JSON.stringify(response).length * 2)
      }
    })
    try {
      await store.prepare()
      const prefix = join(harness.root, ...Array.from({ length: 10 }, () => 'p'.repeat(100)))
      for (let index = 0; index < population; index++) {
        const candidate: SessionFileCandidate = {
          agent: 'claude',
          codexHome: null,
          file: {
            path: join(prefix, `${String(population - index).padStart(4, '0')}.jsonl`),
            mtimeMs: 10000 - Math.floor(index / 4),
            modifiedAt: new Date(10000 - Math.floor(index / 4)).toISOString(),
            sizeBytes: 20
          }
        }
        if (index === 1 || index === 3) {
          const segments = index === 1 ? 12000 : 6000
          const windowsRoot = `C:\\${Array.from({ length: segments }, () => 'p').join('\\')}`
          candidate.agent = 'antigravity'
          candidate.file.path = `${windowsRoot}\\conversation-${index}.pb`
          candidate.antigravityHistoryPath = `${windowsRoot}\\history-${index}.pb`
        }
        candidates.push(candidate)
        await queue.enqueue(candidate, store, false, index % 2 === 0)
      }
      traffic.mockClear()
      queue.beginPass()
      const first = await queue.next()
      expect(first?.candidate.file.path).toBe(candidates[0].file.path)
      const successor = {
        ...candidates[0],
        file: { ...candidates[0].file, mtimeMs: 20000, modifiedAt: '1970-01-01T00:00:20.000Z' }
      }
      await store.candidates({
        kind: 'batch',
        rows: [
          {
            candidate: successor,
            root: prefix,
            group: candidates[0].file.path,
            alias: candidates[0].file.path,
            sqlite: false,
            preference: 0,
            sourceOrder: 0
          }
        ]
      })
      expect((await queue.get(candidates[0].file.path))?.candidate).toEqual(candidates[0])
      queue.beginPass()
      expect(await queue.next()).toEqual(first)
      await queue.acknowledge(first!, true)
      const observed: string[] = []
      for (let index = 1; index < population; index++) {
        let work = await queue.next()
        if (index === 1) {
          await queue.enqueue(candidates[1], store, false, false, true)
          await queue.enqueue(candidates[2], store, true, true)
          await queue.acknowledge(work!, false)
          work = await queue.next()
          expect(work).toMatchObject({ candidate: candidates[1], metadata: true })
        }
        if (index === 2) {
          expect(work).toMatchObject({ candidate: candidates[2], force: true })
        }
        observed.push(work!.candidate.file.path)
        await queue.acknowledge(work!, false)
      }
      expect(observed).toEqual(candidates.slice(1).map((candidate) => candidate.file.path))
      expect(await queue.next()).toBeUndefined()
      // Each lane needs a bounded projection per row/byte page; per-file accepted acknowledgements are separate.
      const pages =
        Math.ceil(population / 256) +
        Math.ceil((JSON.stringify(candidates).length * 2) / (128 * 1024))
      expect(
        traffic.mock.calls.filter(
          ([command]) => command.op === 'work' && command.command.kind === 'next'
        ).length
      ).toBeLessThanOrEqual(40 + 12 * pages)
      queue.beginPass()
      const retry = await queue.next()
      expect(retry?.candidate.file.path).toBe(candidates[0].file.path)
      await queue.enqueue(successor, store, false, true, true)
      await queue.acknowledge(retry!, false)
      const latest = await queue.next()
      expect(latest).toMatchObject({ candidate: successor, metadata: true })
      await queue.acknowledge(latest!, false)
      expect(await queue.next()).toBeUndefined()
      expect(largestResponse).toBeLessThanOrEqual(256 * 1024)
    } finally {
      configureSessionSearchWorkerFixture()
      traffic.mockRestore()
      await store.flush()
      store.close()
      await harness.cleanup()
    }
  }
)
