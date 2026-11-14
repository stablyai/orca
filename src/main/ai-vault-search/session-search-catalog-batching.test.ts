import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/discovery/session-scanner-discovery'
import { SessionSearchCatalog } from './session-search-catalog'
import type { SessionSearchCatalogCommand } from './session-search-catalog'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript
} from './indexing/session-search-indexer-test-fixture'
import { SessionSearchIndexer } from './indexing/session-search-indexer'

it.each([40, 400])(
  'searches the newest known transcript before an older candidate page at %s files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-newest-page')
    const clock = new FakeSessionSearchClock()
    clock.costPerNowMs = 1000
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
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

it('removes search results when a multi-page history source is replaced', async () => {
  const population = 400
  const harness = await openSessionSearchIndexerHarness('ss-release-pages')
  const clock = new FakeSessionSearchClock()
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
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
    expect(matches()).toEqual({ n: 800 })
    await rm(harness.claudeProjectDir, { recursive: true })
    await mkdir(harness.claudeProjectDir)
    const next = join(harness.root, 'next-projects')
    await mkdir(next)
    harness.roots.claudeProjectsDir = next
    await subject.reconcile({ full: true })
    await subject.reconcile()
    expect(matches()).toEqual({ n: 0 })
    expect(subject.status().phase).toBe('current')
  } finally {
    await subject.close()
    await harness.cleanup()
  }
})

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
      discoveryPolicy: 'event-led',
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

it.each(['observation apply', 'probe end', 'probe begin reply'])(
  'settles a returned inventory after partial retirement interrupts %s',
  async (cut) => {
    const harness = await openSessionSearchIndexerHarness('ss-returned-observation')
    const db = new SyncDatabase('')
    const catalog = new SessionSearchCatalog(db)
    const root = join(harness.root, 'returning')
    const path = join(root, 'session.jsonl')
    let refuse = false
    const request = async (command: SessionSearchCatalogCommand) => {
      const selected =
        cut === 'observation apply'
          ? 'observe-apply'
          : cut === 'probe end'
            ? 'authority-probe-end'
            : 'authority-probe'
      if (refuse && command.kind === selected) {
        refuse = false
        if (command.kind === 'authority-probe') {
          catalog.response(command)
        }
        throw new Error('fixture retained observation interruption')
      }
      return catalog.response(command)
    }
    const inventory = new SessionFileInventory(root, request, 'physical:returning-observation')
    const args: DiscoverSessionFilesArgs = {
      rootDir: root,
      agent: 'claude',
      limit: 0,
      issues: [],
      extensions: ['.jsonl']
    }
    const drain = async () => {
      const paths = new Set<string>()
      for (let pass = 0; pass < 100 && inventory.pending; pass++) {
        await inventory.retryFailures()
        const delta = await inventory.drain(args, () => false, 0)
        for (const change of delta.changes) {
          paths.add(change.file.path)
        }
        await inventory.acknowledge(delta.receipts)
      }
      expect(inventory.pending).toBe(false)
      return [...paths]
    }
    try {
      await mkdir(root)
      await writeFile(path, '{}\n')
      await inventory.begin(false, args)
      expect(await drain()).toEqual([path])
      refuse = true
      await inventory.invalidate(cut === 'observation apply' ? path : root)
      await expect(inventory.drain(args, () => false, 0)).rejects.toThrow(
        'fixture retained observation interruption'
      )
      const interruptions = cut === 'probe begin reply' ? 125 : 300
      for (let index = 0; index < interruptions; index++) {
        await inventory.invalidate(join(root, `unavailable-${index}.jsonl`))
      }
      expect(await inventory.releasePage()).toBe(false)
      await inventory.reactivate()
      await inventory.begin(false, args)
      const changes = await drain()
      if (cut === 'observation apply') {
        expect(changes).toEqual([path])
      }
      const currentPaths: string[] = []
      for await (const currentPath of inventory.paths()) {
        currentPaths.push(currentPath)
      }
      expect(currentPaths).toEqual([path])
      expect(args.issues).toEqual([])
    } finally {
      db.close()
      await harness.cleanup()
    }
  }
)

it('pages and releases every descendant of a path containing Unicode names', () => {
  const db = new SyncDatabase('')
  const catalog = new SessionSearchCatalog(db)
  const scope = 'prefix-contract'
  try {
    catalog.execute({
      kind: 'put',
      scope,
      rows: [
        '/root/plain',
        '/root/😀notes/a.jsonl',
        '/root/\u{10ffff}/nested.jsonl',
        '/root-else/kept'
      ].map((key) => ({
        key,
        value: '{}',
        parent: '',
        group: '',
        rank: 0,
        ready: 0
      }))
    })
    expect(
      catalog.execute({ kind: 'page', scope, prefix: '/root/' }).rows?.map(({ key }) => key)
    ).toEqual(['/root/plain', '/root/😀notes/a.jsonl', '/root/\u{10ffff}/nested.jsonl'])
    catalog.execute({ kind: 'release-prefix', scope, prefix: '/root' })
    expect(catalog.execute({ kind: 'page', scope }).rows?.map(({ key }) => key)).toEqual([
      '/root-else/kept'
    ])
  } finally {
    db.close()
  }
})
