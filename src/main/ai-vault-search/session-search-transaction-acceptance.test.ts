import './session-search-watcher.test-fixture'
import { configureSessionSearchWorkerFixture } from './worker/session-search-worker.test-fixture'
import { SessionSearchWorkerStore } from './worker/session-search-worker-store'
import { SessionSearchPassState } from './session-search-pass-state'
import { runSessionSearchPass } from './indexing/session-search-pass'
import { SessionSearchDirectoryListings } from './discovery/session-search-directory-listings'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import { SessionSearchStore } from './storage/session-search-store'
import { SessionSearchCandidateInventory } from './session-search-candidate-inventory'
import {
  SessionSearchIndexConsumer,
  registerSessionSearchIndexConsumer
} from './indexing/session-search-index-consumer'
import { SessionSearchEngine } from './query/session-search-engine'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession
} from './storage/session-search-index-test-fixture'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './indexing/session-search-indexer-test-fixture'

vi.mock('./session-search-filesystem', () => ({ sessionSearchRequiresPolling: async () => false }))

it('finishes the first conversation after its discovery transfer rolls back internally', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-first-transfer-rollback')
  const path = join(harness.claudeProjectDir, 'session.jsonl')
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(signal, 0, 1)
  configureSessionSearchWorkerFixture({
    data: { path, signal: signal.buffer },
    prelude: `
      const { workerData } = require('node:worker_threads');
      const { SessionSearchStore } = require(${JSON.stringify(resolve('src/main/ai-vault-search/storage/session-search-store.ts'))});
      const candidates = SessionSearchStore.prototype.candidates;
      SessionSearchStore.prototype.candidates = async function(command) {
        if (command.kind !== 'batch' || !command.admission || !command.rows.some(row => row.candidate.file.path === workerData.path) || Atomics.compareExchange(new Int32Array(workerData.signal), 0, 1, 0) !== 1) return candidates.call(this, command);
        this.connection.exec("CREATE TEMP TRIGGER refuse_first_transfer BEFORE UPDATE OF delivery_revision ON search_inventory_activity WHEN OLD.delivery_revision IS NOT NULL AND NEW.delivery_revision IS NULL BEGIN SELECT RAISE(ABORT,'fixture first transfer rollback'); END");
        try { return await candidates.call(this, command); }
        finally { this.connection.exec('DROP TRIGGER refuse_first_transfer'); }
      };
    `,
    onResponse: () => undefined
  })
  const store = new SessionSearchWorkerStore(harness.databasePath, () => undefined)
  const state = new SessionSearchPassState()
  const unregister = registerSessionSearchIndexConsumer(store, state.candidates)
  state.discovery.onDiscovery(async (discovery, forced, metadata, inputs) => {
    const update = await state.candidates.update(
      [discovery],
      new Set(),
      harness.roots,
      forced,
      new Map(),
      true,
      metadata,
      new Map(),
      inputs ? { inputs, recent: false, recovering: false } : undefined
    )
    if (update.scopeCounts) {
      state.acceptCounts(update.scopeCounts)
    }
    if (update.work) {
      state.queue.update(update.work)
    }
    return inputs !== undefined
  })
  const hits = () =>
    harness.read((db) =>
      db
        .prepare(
          "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'firsttransferneedle'"
        )
        .get()
    )
  try {
    await writeClaudeTranscript(path, ['firsttransferneedle'], 'first-transfer')
    await store.prepare()
    await state.prepare(store)
    state.discovery.begin({ full: true, maintenance: true, recentLimit: 12, overdue: () => false })
    await expect(
      state.discovery.files({
        rootDir: harness.roots.claudeProjectsDir!,
        agent: 'claude',
        limit: 0,
        issues: [],
        extensions: ['.jsonl']
      })
    ).rejects.toThrow('fixture first transfer rollback')
    expect(Atomics.load(signal, 0)).toBe(0)
    expect(hits()).toEqual({ n: 0 })
    const result = await runSessionSearchPass({
      store,
      state,
      roots: harness.roots,
      full: false,
      purge: false,
      recentPerAgent: 12,
      listings: new SessionSearchDirectoryListings()
    })
    expect(hits()).toEqual({ n: 2 })
    expect(result).toMatchObject({
      completed: true,
      outOfTime: false,
      pending: false,
      degradedRoots: []
    })
  } finally {
    unregister()
    await state.close()
    store.close()
    await store.retired()
    configureSessionSearchWorkerFixture()
    await harness.cleanup()
  }
})

it.each(['dirty', 'input-receipts'])(
  'publishes failed-row recovery only after the %s transaction accepts',
  async (suffix) => {
    const harness = await openSessionSearchIndexerHarness('ss-transaction-acceptance')
    const path = join(harness.claudeProjectDir, 'session.jsonl')
    const signal = new Int32Array(new SharedArrayBuffer(4))
    const wakes: string[] = []
    configureSessionSearchWorkerFixture({
      data: { path, suffix, signal: signal.buffer },
      prelude: `
        const { workerData } = require('node:worker_threads');
        const { SessionSearchStore } = require(${JSON.stringify(resolve('src/main/ai-vault-search/storage/session-search-store.ts'))});
        const catalog = SessionSearchStore.prototype.catalog;
        SessionSearchStore.prototype.catalog = async function(command) {
          if (command.kind !== 'input-invalidate' || command.path !== workerData.path || Atomics.compareExchange(new Int32Array(workerData.signal), 0, 1, 0) !== 1) return catalog.call(this, command);
          this.connection.exec("CREATE TEMP TRIGGER refuse_catalog_acceptance BEFORE INSERT ON search_catalog WHEN NEW.scope LIKE '%:" + workerData.suffix + "' BEGIN SELECT RAISE(ABORT,'fixture internal catalog refusal'); END");
          try { return await catalog.call(this, command); }
          finally { this.connection.exec('DROP TRIGGER refuse_catalog_acceptance'); }
        };
      `,
      onResponse: (response) => {
        if (response.id === 0) {
          for (const delta of response.deltas ?? []) {
            if (delta.path === path && delta.row) {
              wakes.push(delta.row.state)
            }
          }
        }
      }
    })
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock: new FakeSessionSearchClock(),
      onError: () => undefined
    })
    const hits = (term: string) =>
      harness.read((db) =>
        db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(term)
      )
    try {
      await writeClaudeTranscript(path, ['transactionold'], 'transaction')
      await subject.start()
      harness.write((db) =>
        db
          .prepare(
            "UPDATE files SET state='failed',fail_count=3,failed_mtime_ms=mtime_ms WHERE path=?"
          )
          .run(path)
      )
      await subject.reconcile()
      expect(subject.status().filesFailed).toBe(1)
      wakes.length = 0
      Atomics.store(signal, 0, 1)
      await writeClaudeTranscript(path, ['transactionnew'], 'transaction')
      await subject.reconcile()
      expect(Atomics.load(signal, 0)).toBe(0)
      expect(
        harness.read((db) =>
          db.prepare('SELECT state,fail_count FROM files WHERE path=?').get(path)
        )
      ).toEqual({ state: 'failed', fail_count: 3 })
      expect(subject.status().filesFailed).toBe(1)
      expect(wakes).toEqual([])
      expect(hits('transactionold')).toEqual({ n: 2 })
      expect(hits('transactionnew')).toEqual({ n: 0 })
      // The original native receipt is the only retry input.
      await subject.reconcile()
      expect(hits('transactionnew')).toEqual({ n: 2 })
      expect(hits('transactionold')).toEqual({ n: 0 })
      expect(wakes).toEqual(['current'])
      expect(subject.status().filesFailed).toBe(0)
      expect(subject.status().phase).toBe('current')
    } finally {
      await subject.close()
      configureSessionSearchWorkerFixture()
      await harness.cleanup()
    }
  }
)

it('rolls back an existing alias publication with its failed input and preserves accepted replay', async () => {
  const index = await openSessionSearchIndexFile('ss-publication-acceptance')
  const store = new SessionSearchStore(index.path)
  const inventory = new SessionSearchCandidateInventory(store)
  const engine = new SessionSearchEngine(index.db)
  const candidates = ['previous', 'selected'].map((name, n) => ({
    ...syntheticCandidate({ path: `/archive/${name}.db#shared`, mtimeMs: 100 + n }),
    agent: 'opencode' as const
  }))
  const selected = candidates[1]
  const input = {
    kind: 'input-invalidate' as const,
    scope: 'physical:transaction',
    path: selected.file.path,
    force: true,
    receipt: { consumer: 'transaction-control', revision: 1 }
  }
  try {
    await inventory.update(
      [{ agent: 'opencode', rootDir: '/archive', files: candidates.map((row) => row.file) }],
      new Set(),
      {}
    )
    const consumer = new SessionSearchIndexConsumer(store, undefined, inventory).beginRead({
      candidate: selected,
      mode: 'replace',
      previousByteOffset: 0
    })!
    consumer.message({ role: 'user', text: 'acceptedpublicationneedle', timestamp: null })
    consumer.finish({
      session: syntheticSession({ agent: 'opencode', filePath: selected.file.path }),
      byteOffset: 100,
      incomplete: false
    })
    await inventory.acknowledgeChanges(
      (await inventory.update([], new Set(), {}, new Set(), new Map(), true)).receipts
    )
    await inventory.reconcilePublications(store, () => false)
    expect(inventory.pendingPublications).toBe(false)
    await store.catalog({ kind: 'authority-open', scope: input.scope, root: '/archive' })
    store.connection.exec(
      "CREATE TEMP TRIGGER refuse_publication_acceptance BEFORE INSERT ON search_catalog WHEN NEW.scope='physical:transaction:input-receipts' BEGIN SELECT RAISE(ABORT,'fixture outer acceptance refusal'); END"
    )
    await expect(store.catalog(input)).rejects.toThrow('fixture outer acceptance refusal')
    expect(engine.search({ query: 'acceptedpublicationneedle' }).hits).toHaveLength(1)
    expect(inventory.pendingPublications).toBe(false)
    store.connection.exec('DROP TRIGGER refuse_publication_acceptance')
    await store.catalog(input)
    const accepted = await inventory.update([], new Set(), {}, new Set(), new Map(), true)
    await inventory.acknowledgeChanges(accepted.receipts)
    await inventory.reconcilePublications(store, () => false)
    expect(inventory.pendingPublications).toBe(false)
    await store.catalog(input)
    expect(inventory.pendingPublications).toBe(false)
    expect(engine.search({ query: 'acceptedpublicationneedle' }).hits).toHaveLength(1)
  } finally {
    inventory.closePublications()
    store.close()
    await index.close()
  }
})
