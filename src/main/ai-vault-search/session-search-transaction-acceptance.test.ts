import './session-search-watcher.test-fixture'
import { createHook } from 'node:async_hooks'
import { configureSessionSearchWorkerFixture } from './worker/session-search-worker.test-fixture'
import { SessionSearchWorkerStore } from './worker/session-search-worker-store'
import { SessionSearchPassState } from './session-search-pass-state'
import { runSessionSearchPass, type SessionSearchPassArgs } from './indexing/session-search-pass'
import {
  retireSessionSearchPassSources,
  wakeSessionSearchPassRetirements
} from './session-search-pass-retirement'
import { SessionSearchDirectoryListings } from './discovery/session-search-directory-listings'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

it('keeps accepted searchable content and retries bookkeeping without charging a read failure', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-content-settlement')
  const path = join(harness.claudeProjectDir, 'session.jsonl')
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(signal, 0, 1)
  configureSessionSearchWorkerFixture({
    data: { path, signal: signal.buffer },
    prelude: `
      const { workerData } = require('node:worker_threads');
      const { SessionSearchStore } = require(${JSON.stringify(resolve('src/main/ai-vault-search/storage/session-search-store.ts'))});
      const { SessionSearchCatalogCandidates } = require(${JSON.stringify(resolve('src/main/ai-vault-search/session-search-catalog-candidates.ts'))});
      const rowChanged = SessionSearchCatalogCandidates.prototype.rowChanged;
      SessionSearchCatalogCandidates.prototype.rowChanged = function(path) {
        if (path === workerData.path && Atomics.compareExchange(new Int32Array(workerData.signal), 0, 2, 0) === 2) { throw new Error('fixture post-content invalidation refusal'); }
        return rowChanged.call(this, path);
      };
      const settle = SessionSearchStore.prototype.settleAcceptedFile;
      SessionSearchStore.prototype.settleAcceptedFile = function(path) {
        settle.call(this, path);
        if (path === workerData.path && Atomics.compareExchange(new Int32Array(workerData.signal), 0, 1, 2) === 1) { throw new Error('fixture post-content settlement refusal'); }
      };
    `,
    onResponse: () => undefined
  })
  const errors: unknown[] = []
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock: new FakeSessionSearchClock(),
    onError: (error) => errors.push(error)
  })
  const hits = () =>
    harness.read((db) =>
      db
        .prepare(
          "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'acceptedcontentneedle'"
        )
        .get()
    )
  try {
    await writeClaudeTranscript(path, ['acceptedcontentneedle'], 'accepted-content')
    await subject.start()
    expect(Atomics.load(signal, 0)).toBe(0)
    expect(hits()).toEqual({ n: 2 })
    expect(subject.status().filesFailed).toBe(0)
    expect(subject.status().phase).not.toBe('current')
    expect(errors).toEqual([])
    await subject.reconcile()
    expect(hits()).toEqual({ n: 2 })
    expect(subject.status().filesFailed).toBe(0)
    expect(subject.status().phase).toBe('current')
  } finally {
    await subject.close()
    configureSessionSearchWorkerFixture()
    await harness.cleanup()
  }
})

it('finishes independent conversations after their discovery transfer rolls back internally', async () => {
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
        if (command.kind !== 'batch' || !command.admission || !command.rows.some(row => row.candidate.file.path === workerData.path) || Atomics.compareExchange(new Int32Array(workerData.signal), 0, 1, 0) !== 1) { return candidates.call(this, command); }
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
    await writeClaudeTranscript(
      join(harness.claudeProjectDir, 'independent-a.jsonl'),
      ['firsttransferneedle'],
      'independent-a'
    )
    await writeClaudeTranscript(
      join(harness.claudeProjectDir, 'independent-b.jsonl'),
      ['firsttransferneedle'],
      'independent-b'
    )
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
    expect(hits()).toEqual({ n: 6 })
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
          if (command.kind !== 'input-invalidate' || command.path !== workerData.path || Atomics.compareExchange(new Int32Array(workerData.signal), 0, 1, 0) !== 1) { return catalog.call(this, command); }
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
      discoveryPolicy: 'event-led',
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

describe('retirement handoff acceptance', () => {
  let harness: Awaited<ReturnType<typeof openSessionSearchIndexerHarness>>
  let store: SessionSearchStore
  beforeEach(async () => {
    harness = await openSessionSearchIndexerHarness('ss-retirement-handoff')
    store = new SessionSearchStore(harness.databasePath)
  })
  afterEach(async () => {
    store.close()
    await harness.cleanup()
  })
  function seedSearchableRows(population: number, directory = harness.claudeProjectDir): string[] {
    const paths: string[] = []
    for (let index = 0; index < population; index++) {
      const path = join(directory, `${String(index).padStart(4, '0')}.jsonl`)
      paths.push(path)
      const write = store.beginWrite(syntheticCandidate({ path }), 'replace', 0)!
      write.add({ role: 'user', text: 'retainedretirementneedle', timestamp: null })
      write.commit({
        session: syntheticSession({
          id: `retirement-${index}`,
          sessionId: `retirement-${index}`,
          filePath: path
        }),
        byteOffset: 100,
        incomplete: false
      })
    }
    return paths
  }
  function retirementArgs(state: SessionSearchPassState): SessionSearchPassArgs {
    return {
      store,
      state,
      roots: harness.roots,
      full: false,
      recentPerAgent: 12,
      listings: { namesIn: async () => ({ listed: true, names: new Set<string>() }) }
    }
  }
  function retainedRows(): number {
    return Number(
      store.connection
        .prepare(
          "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'retainedretirementneedle'"
        )
        .get()?.n ?? 0
    )
  }

  it('advances a long retirement sweep while one queued removal is refused', async () => {
    const paths = seedSearchableRows(600)
    const held = paths[0]
    store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
    const remove = store.removeFile.bind(store)
    let refusing = true
    vi.spyOn(store, 'removeFile').mockImplementation((path) => {
      if (path === held && refusing) {
        return false
      }
      return remove(path)
    })
    const state = new SessionSearchPassState()
    await state.prepare(store)
    await state.retire.set(held, held)
    try {
      const args = retirementArgs(state)
      await retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
      expect(retainedRows()).toBe(1)
      refusing = false
      await retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
      expect(retainedRows()).toBe(0)
      expect(state.pending).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await state.close()
    }
  })

  it('progresses a queued tail and the full sweep while an earlier page stays refused', async () => {
    const paths = seedSearchableRows(600)
    const held = new Set(paths.slice(0, 256))
    const remove = SessionSearchStore.prototype.removeFile.bind(store)
    store.removeFile = (path) => (held.has(path) ? false : remove(path))
    const state = new SessionSearchPassState()
    await state.prepare(store)
    await state.retire.setPage(paths.slice(0, 257).map((path) => [path, path] as const))
    try {
      const args = { ...retirementArgs(state), discoveryOverdue: () => true }
      // Three sweep pages alternate with queued turns, with one final EOF turn available.
      for (let cycle = 0; cycle < 8; cycle++) {
        await retireSessionSearchPassSources(args, [harness.claudeProjectDir], new Set())
      }
      expect(store.fileRow(paths[256])).toBeUndefined()
      expect(store.fileRow(paths[599])).toBeUndefined()
      expect(retainedRows()).toBe(256)
      expect(state.pending).toBe(true)
      held.clear()
      await retireSessionSearchPassSources(
        retirementArgs(state),
        [harness.claudeProjectDir],
        new Set()
      )
      expect(retainedRows()).toBe(0)
      expect(state.pending).toBe(false)
    } finally {
      await state.close()
    }
  })

  it('continues an interrupted parked-retirement wake without consuming newer receipts', async () => {
    const paths = seedSearchableRows(300)
    store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
    const state = new SessionSearchPassState()
    await state.prepare(store)
    state.needsRetirement = false
    await state.parkedRetire.setPage(paths.map((path) => [path, path] as const))
    const args = retirementArgs(state)
    const roots = [harness.roots.claudeProjectsDir!]
    const goodListings = args.listings
    const request = store.catalog.bind(store)
    let refuseTransfer = false
    const transfer = vi.spyOn(store, 'catalog').mockImplementation((command) => {
      if (refuseTransfer && command.kind === 'frontier-move') {
        refuseTransfer = false
        return Promise.reject(new Error('fixture interrupted retirement wake'))
      }
      return request(command)
    })
    try {
      // The first wake page is transferred; its removals refuse and return to parked state.
      await wakeSessionSearchPassRetirements({ ...args, full: true, discoveryOverdue: () => true })
      await retireSessionSearchPassSources(
        {
          ...args,
          listings: {
            namesIn: async () => ({
              listed: false,
              code: 'EIO',
              message: 'fixture inaccessible volume'
            })
          }
        },
        roots,
        new Set()
      )
      expect(retainedRows()).toBe(300)
      const newer = paths.at(-1)!
      await state.parkedRetire.set(newer, newer)
      refuseTransfer = true
      await expect(wakeSessionSearchPassRetirements(args)).rejects.toThrow(
        'fixture interrupted retirement wake'
      )
      // An ordinary pass must carry the original wake through its remaining tail.
      await wakeSessionSearchPassRetirements(args)
      await retireSessionSearchPassSources({ ...args, listings: goodListings }, roots, new Set())
      expect(retainedRows()).toBe(257)
      expect(store.fileRow(newer)).toBeDefined()
      expect(state.pending).toBe(false)
      await wakeSessionSearchPassRetirements(args)
      await retireSessionSearchPassSources(args, roots, new Set())
      expect(retainedRows()).toBe(257)
      // A new explicit wake can now retry the protected earlier page.
      await wakeSessionSearchPassRetirements({ ...args, full: true })
      await retireSessionSearchPassSources(args, roots, new Set())
      expect(retainedRows()).toBe(0)
      expect(state.pending).toBe(false)
    } finally {
      transfer.mockRestore()
      await state.close()
    }
  })

  it('retains a refused retirement remainder at EOF after an earlier unit finished', async () => {
    const paths = seedSearchableRows(300)
    const owned = paths.at(-1)!
    store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
    const state = new SessionSearchPassState()
    await state.prepare(store)
    const candidate = syntheticCandidate({ path: owned })
    await store.candidates({
      kind: 'batch',
      rows: [
        {
          candidate,
          root: harness.claudeProjectDir,
          group: owned,
          alias: owned,
          sqlite: false,
          preference: 0,
          sourceOrder: 0
        }
      ]
    })
    for (const row of (await store.candidates({ kind: 'changes' })).rows) {
      await store.candidates({ kind: 'consumed', key: row.key, revision: row.revision })
    }
    await state.candidates.reconcilePublications(store, () => false)
    const request = store.candidates.bind(store)
    let unit = 0
    const admission = vi.spyOn(store, 'candidates').mockImplementation((command) => {
      if (command.kind === 'unowned-page' && ++unit === 2) {
        return Promise.reject(new Error('fixture declined later membership unit'))
      }
      return request(command)
    })
    try {
      const args = retirementArgs(state)
      await expect(
        retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
      ).rejects.toThrow('fixture declined later membership unit')
      expect(retainedRows()).toBe(44)
      await retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
      expect(retainedRows()).toBe(1)
      expect(store.fileRow(owned)).toBeDefined()
      expect(state.pending).toBe(false)
    } finally {
      admission.mockRestore()
      await state.close()
    }
  })

  it('retains queued retirement when its replacement handoff is rejected', async () => {
    const [path] = seedSearchableRows(1)
    const remove = SessionSearchStore.prototype.removeFile.bind(store)
    let refusing = true
    store.removeFile = (target) => (refusing ? false : remove(target))
    const state = new SessionSearchPassState()
    await state.prepare(store)
    state.needsRetirement = false
    await state.retire.set(path, path)
    const request = store.catalog.bind(store)
    let rejectHandoff = true
    const handoff = vi.spyOn(store, 'catalog').mockImplementation((command) => {
      if (rejectHandoff && command.kind === 'frontier-settle' && command.scope === 'retirement') {
        rejectHandoff = false
        return Promise.reject(new Error('fixture rejected replacement retirement'))
      }
      return request(command)
    })
    try {
      const args = retirementArgs(state)
      const roots = [harness.roots.claudeProjectsDir!]
      await expect(retireSessionSearchPassSources(args, roots, new Set())).rejects.toThrow(
        'fixture rejected replacement retirement'
      )
      expect(retainedRows()).toBe(1)
      refusing = false
      await retireSessionSearchPassSources(args, roots, new Set())
      expect(retainedRows()).toBe(0)
      expect(state.pending).toBe(false)
    } finally {
      handoff.mockRestore()
      await state.close()
    }
  })

  it.each([200, 2000])(
    'yields an all-owned %s-conversation sweep and resumes without repeating membership work',
    async (population) => {
      const paths = seedSearchableRows(population)
      const state = new SessionSearchPassState()
      await state.prepare(store)
      for (let offset = 0; offset < paths.length; offset += 64) {
        await store.candidates({
          kind: 'batch',
          rows: paths.slice(offset, offset + 64).map((path) => ({
            candidate: syntheticCandidate({ path }),
            root: harness.claudeProjectDir,
            group: path,
            alias: path,
            sqlite: false,
            preference: 0,
            sourceOrder: 0
          }))
        })
      }
      const request = store.candidates.bind(store)
      let compared = 0
      const membership = vi.spyOn(store, 'candidates').mockImplementation((command) => {
        if (command.kind === 'unowned-page') {
          compared += command.rows.length
        }
        return request(command)
      })
      try {
        const args = { ...retirementArgs(state), discoveryOverdue: () => true }
        let total = 0
        for (let cycle = 0; cycle < Math.ceil(population / 256) + 1; cycle++) {
          compared = 0
          await retireSessionSearchPassSources(args, [harness.claudeProjectDir], new Set())
          // A reached deadline permits one bounded membership unit, including units with no removals.
          expect(compared).toBeLessThanOrEqual(256)
          total += compared
        }
        expect(total).toBe(population)
        expect(retainedRows()).toBe(population)
      } finally {
        membership.mockRestore()
        await state.close()
      }
    }
  )
  it.each([200, 2000])(
    'keeps long-path retirement work linear for %s conversations',
    async (population) => {
      const directory = join(
        harness.claudeProjectDir,
        ...Array.from({ length: 17 }, () => 'd'.repeat(200))
      )
      seedSearchableRows(population, directory)
      store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
      const state = new SessionSearchPassState()
      await state.prepare(store)
      let promises = 0
      const hook = createHook({
        init: (_id, kind) => {
          if (kind === 'PROMISE') {
            promises++
          }
        }
      })
      try {
        hook.enable()
        await retireSessionSearchPassSources(
          retirementArgs(state),
          [harness.roots.claudeProjectsDir!],
          new Set()
        )
        hook.disable()
        expect(retainedRows()).toBe(0)
        expect(state.pending).toBe(false)
        // One advance, membership verdict, absence proof and release need at most sixteen async boundaries per input (four promise events each), plus fixed dispatch.
        expect(promises).toBeLessThanOrEqual(64 * population + 2000)
      } finally {
        hook.disable()
        await state.close()
      }
    }
  )

  it('keeps one unfinished retirement unit through repeated membership rejection', async () => {
    seedSearchableRows(300)
    store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
    const state = new SessionSearchPassState()
    await state.prepare(store)
    const request = store.candidates.bind(store)
    let refusing = true
    const refusal = vi.spyOn(store, 'candidates').mockImplementation((command) => {
      if (refusing && command.kind === 'unowned-page') {
        return Promise.reject(new Error('fixture refused current retirement unit'))
      }
      return request(command)
    })
    let promises = 0
    const hook = createHook({
      init: (_id, kind) => {
        if (kind === 'PROMISE') {
          promises++
        }
      }
    })
    try {
      for (let attempt = 0; attempt < 32; attempt++) {
        promises = 0
        hook.enable()
        await expect(
          retireSessionSearchPassSources(
            retirementArgs(state),
            [harness.roots.claudeProjectsDir!],
            new Set()
          )
        ).rejects.toThrow('fixture refused current retirement unit')
        hook.disable()
        // A rejected page retains its 256 inputs; retry does not create another traversal per earlier rejection.
        expect(promises).toBeLessThanOrEqual(64 * 256 + 2000)
      }
      expect(retainedRows()).toBe(300)
      refusing = false
      promises = 0
      hook.enable()
      await retireSessionSearchPassSources(
        retirementArgs(state),
        [harness.roots.claudeProjectsDir!],
        new Set()
      )
      hook.disable()
      expect(promises).toBeLessThanOrEqual(64 * 300 + 2000)
      expect(retainedRows()).toBe(0)
      expect(state.pending).toBe(false)
    } finally {
      hook.disable()
      refusal.mockRestore()
      await state.close()
    }
  })
})

it('cancels an obsolete released inventory request without reporting a background failure', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-released-worker-request')
  const errors: unknown[] = []
  const store = new SessionSearchWorkerStore(harness.databasePath, (error) => errors.push(error))
  try {
    await store.prepare()
    await store.catalog({
      kind: 'authority-open',
      scope: 'physical:released-worker',
      root: harness.root
    })
    let released = false
    while (!released) {
      released =
        (await store.catalog({ kind: 'release-scopes-page', scope: 'physical:released-worker' }))
          .count === 0
    }
    await expect(
      store.catalog({
        kind: 'get',
        scope: 'physical:released-worker:files',
        key: join(harness.root, 'gone.jsonl')
      })
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Agent Session History scan was cancelled'
    })
    await store.flush()
    expect(errors).toEqual([])
  } finally {
    store.close()
    await harness.cleanup()
  }
})
