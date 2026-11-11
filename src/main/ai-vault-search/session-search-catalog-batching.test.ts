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
} from './session-search-indexer-test-fixture'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { SessionSearchIndexer } from './session-search-indexer'

it.each([40, 400])(
  'batches discovery and replacement metadata for %s retained files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-catalog-pages')
    const db = new SyncDatabase('')
    const catalog = new SessionSearchCatalog(db)
    let envelopes = 0,
      localRows = 0
    let invalidEnvelope = false
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
      invalidEnvelope ||=
        JSON.stringify(command).length * 2 > 256 * 1024 ||
        JSON.stringify(result).length * 2 > 256 * 1024
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
      // Required comparisons and accepted observations visit each input only a fixed number of times locally.
      expect(localRows).toBeLessThanOrEqual(30 * population + 100)
      expect(invalidEnvelope).toBe(false)
    }
    const reset = () => {
      envelopes = 0
      localRows = 0
      invalidEnvelope = false
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
      const residual = () =>
        db
          .prepare('SELECT count(*) AS n FROM temp.search_catalog WHERE scope IN (?,?)')
          .get('physical:batch-control:authority', 'physical:batch-control:authority-garbage')
      expect(residual()).toEqual({ n: 0 })
      reset()
      await inventory.reconcile()
      expect(await drain()).toEqual([])
      check()
      reset()
      await inventory.invalidate(root)
      expect(await drain()).toEqual([])
      check()
      expect(residual()).toEqual({ n: 0 })
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
      local.mockRestore()
      db.close()
      await harness.cleanup()
    }
  }
)

it('searches the newest known transcript before an older candidate page', async () => {
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
    for (let index = 0; index < 300; index++) {
      const path = join(harness.claudeProjectDir, `${String(index).padStart(3, '0')}.jsonl`)
      await writeClaudeTranscript(
        path,
        [index === 299 ? 'newestknownneedle' : 'olderknownneedle'],
        `session-${index}`
      )
      const time = new Date(index === 299 ? '2025-01-02' : '2025-01-01')
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
})

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
