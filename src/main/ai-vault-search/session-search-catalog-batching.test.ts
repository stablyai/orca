import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import { SessionSearchCatalog } from './session-search-catalog'
import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult
} from './session-search-catalog'
import { createSessionSearchJsonlDependency } from './session-search-jsonl-dependency'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './session-search-indexer-test-fixture'
import { SessionSearchIndexer } from './session-search-indexer'
import { utimes } from 'node:fs/promises'

it.each([40, 400])(
  'batches discovery and replacement metadata for %s retained files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-catalog-pages')
    const db = new SyncDatabase('')
    const catalog = new SessionSearchCatalog(db)
    let envelopes = 0,
      localRows = 0
    const transferred: [SessionSearchCatalogCommand, SessionSearchCatalogResult][] = []
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
      transferred.push([command, result])
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
        const delta = await inventory.drain(args, () => false, 0)
        paths.push(...delta.changes.map(({ file }) => file.path))
      }
      return paths
    }
    const check = () => {
      // A single directory has fixed phase transitions; each page needs staging, preparation and acceptance, independent of its member count.
      const pages = Math.ceil(population / 256)
      expect(envelopes).toBeLessThanOrEqual(40 + 12 * pages)
      // Required comparisons and accepted observations visit each input only a fixed number of times locally.
      expect(localRows).toBeLessThanOrEqual(30 * population + 100)
      for (const [input, output] of transferred) {
        expect(JSON.stringify(input).length * 2).toBeLessThanOrEqual(256 * 1024)
        expect(JSON.stringify(output).length * 2).toBeLessThanOrEqual(256 * 1024)
      }
    }
    const reset = () => {
      envelopes = 0
      localRows = 0
      transferred.length = 0
    }
    try {
      await mkdir(root)
      for (let index = 0; index < population; index++) {
        await writeFile(join(root, `${index}.jsonl`), '{}\n')
      }
      await inventory.begin(false, args)
      expect(await drain()).toHaveLength(population)
      check()
      reset()
      await inventory.reconcile()
      expect(await drain()).toEqual([])
      check()
      reset()
      await inventory.invalidate(root)
      expect(await drain()).toEqual([])
      check()
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
