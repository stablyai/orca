import {
  harness,
  clock,
  ownIndexer,
  dbPath,
  openEngine,
  startIndexer,
  finishPendingObservation,
  openCodeObservation,
  openCodeListObservations
} from './session-search-opencode-index.test-fixture'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/wsl-transcript-fs-access'
import { readWholeTranscript } from '../ai-vault/transcripts/session-transcript-reader'
import { buildOpenCodeSqliteCandidatePath } from '../../shared/opencode-sqlite-session-path'
import {
  appendOpenCodeSqliteTurn,
  writeOpenCodeSqliteDatabase
} from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-fixture'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  SessionSearchOperationError,
  SessionSearchWorkerClient
} from './session-search-worker-client'

const ANSWER = 'the quokkaTelemetry harness reindexes every shard'
const OTHER = 'a completely unrelated conversation about typography'
const TOOL_ONLY = 'zarquonium'
const TOOL_FILE = '/repo/app/src/telemetry/shard-reindex.ts'
const SESSION = 'ses_capture'
const SECOND_SESSION = 'ses_second'

function writeVault(): void {
  writeOpenCodeSqliteDatabase(dbPath(), [
    {
      id: SESSION,
      title: 'Telemetry work',
      directory: '/tmp/opencode',
      turns: [
        { role: 'user', parts: ['how do I reindex the shards'] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Checking how the shard map is built.' },
            'Here is the plan.',
            ANSWER,
            {
              type: 'tool',
              tool: 'read',
              // OpenCode’s filePath spelling must normalize to the indexed file_path key.
              input: { filePath: TOOL_FILE },
              output: `export const marker = '${TOOL_ONLY}'`
            },
            {
              type: 'tool',
              tool: 'bash',
              input: { command: 'pnpm reindex --all' },
              error: 'reindex exited with code 2'
            }
          ]
        }
      ]
    },
    {
      id: SECOND_SESSION,
      title: 'Typography',
      directory: '/tmp/opencode-two',
      turns: [{ role: 'assistant', parts: [OTHER] }]
    }
  ])
}

it('excludes tool output from both search scopes', async () => {
  writeVault()
  await startIndexer()

  const all = openEngine().search({ query: TOOL_ONLY, scope: 'all' })
  expect(all.hits).toEqual([])
  expect(openEngine().search({ query: TOOL_ONLY, scope: 'conversation' }).hits).toEqual([])
})

it('re-reads a session that gained a message and replaces its rows', async () => {
  writeVault()
  const started = await startIndexer()
  expect(openEngine().search({ query: 'orthogonal vestibule' }).hits).toHaveLength(0)

  appendOpenCodeSqliteTurn(dbPath(), SESSION, {
    role: 'assistant',
    parts: ['an orthogonal vestibule appeared']
  })
  await started.reconcile()

  const engine = openEngine()
  expect(engine.search({ query: 'orthogonal vestibule' }).hits[0]?.sessionId).toBe(SESSION)
  expect(engine.search({ query: ANSWER }).hits).toHaveLength(1)
})

it.each([40, 400])(
  'keeps recent database observations bounded at %s rows while old imports reach search on maintenance',
  async (population) => {
    writeOpenCodeSqliteDatabase(
      dbPath(),
      Array.from({ length: population }, (_, index) => ({
        id: `ses_${index}`,
        turns: [{ role: 'user', parts: ['retainedarchive'] }]
      }))
    )
    const subject = await startIndexer({ fullSweepEveryCycles: 15 })
    appendOpenCodeSqliteTurn(dbPath(), 'ses_0', {
      role: 'assistant',
      parts: ['recentdatabaseneedle']
    })
    clock.advance(20000)
    await subject.settled()
    expect(openEngine().search({ query: 'recentdatabaseneedle' }).hits[0]?.sessionId).toBe('ses_0')
    expect(openCodeListObservations.at(-1)).toMatchObject({ limit: 12, rows: 12 })
    writeOpenCodeSqliteDatabase(dbPath(), [
      { id: 'ses_imported', turns: [{ role: 'user', parts: ['oldimportneedle'] }] }
    ])
    const source = new SyncDatabase(dbPath())
    source
      .prepare("UPDATE session SET time_created=1000, time_updated=2000 WHERE id='ses_imported'")
      .run()
    source.close()
    for (let cycle = 0; cycle < 14; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(
      openCodeListObservations.filter((observation) => observation.limit === Infinity)
    ).toHaveLength(2)
    expect(
      openCodeListObservations
        .filter((observation) => observation.limit === 12)
        .every((observation) => observation.rows === 12)
    ).toBe(true)
    expect(openEngine().search({ query: 'oldimportneedle' }).hits[0]?.sessionId).toBe(
      'ses_imported'
    )
  }
)

it('keeps a duplicate physical row and promotes it when the selected database disappears', async () => {
  const storage = harness.roots.opencodeStorageDir
  for (const [id, text] of [
    ['ses_shared', 'legacycopyneedle'],
    ['ses_legacy', 'legacyonlyneedle']
  ]) {
    const sessionPath = join(storage, 'session', 'project', `${id}.json`)
    const messagePath = join(storage, 'message', id, 'message.json')
    await mkdir(dirname(sessionPath), { recursive: true })
    await mkdir(dirname(messagePath), { recursive: true })
    await writeFile(sessionPath, JSON.stringify({ id, title: text }))
    await writeFile(
      messagePath,
      JSON.stringify({ role: 'user', content: [{ type: 'text', text }] })
    )
  }
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['winningcopyneedle'] }] },
    { id: 'ses_primary', turns: [{ role: 'user', parts: ['primaryonlyneedle'] }] }
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['alternativecopyneedle'] }] },
    { id: 'ses_alternative', turns: [{ role: 'user', parts: ['alternativeonlyneedle'] }] }
  ])
  let paths = [dbPath(), alternative]
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: paths },
    resolveRoots: async () => ({ ...harness.roots, opencodeDbPaths: paths }),
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  ownIndexer(subject)
  await subject.start()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'winningcopyneedle' }).hits).toHaveLength(1)
  expect(openEngine().search({ query: 'alternativecopyneedle' }).hits).toHaveLength(0)
  expect(openEngine().search({ query: 'legacycopyneedle' }).hits).toHaveLength(0)
  expect(openEngine().search({ query: 'legacyonlyneedle' }).hits).toHaveLength(1)
  appendOpenCodeSqliteTurn(dbPath(), 'ses_shared', {
    role: 'assistant',
    parts: ['mixedsourceupdateneedle']
  })
  await subject.reconcile()
  expect(openEngine().search({ query: 'mixedsourceupdateneedle' }).hits).toHaveLength(1)
  await rm(dbPath())
  paths = [alternative]
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'alternativecopyneedle' }).hits[0]?.sessionId).toBe(
    'ses_shared'
  )
  expect(openEngine().search({ query: 'winningcopyneedle' }).hits).toHaveLength(0)
  expect(openEngine().search({ query: 'primaryonlyneedle' }).hits).toHaveLength(0)
  await rm(alternative)
  paths = []
  await subject.reconcile({ full: true })
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'legacycopyneedle' }).hits[0]?.sessionId).toBe('ses_shared')
  expect(openEngine().search({ query: 'alternativecopyneedle' }).hits).toHaveLength(0)
  expect(openEngine().search({ query: 'legacyonlyneedle' }).hits).toHaveLength(1)
  expect(subject.status().phase).toBe('current')
})

it('retains refused database membership while healthy owners settle and retries only the refused full observation', async () => {
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_primary', turns: [{ role: 'user', parts: ['preservedneedle'] }] },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `ses_recent_${index}`,
      turns: [{ role: 'user' as const, parts: ['recentarchive'] }]
    }))
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_alternative', turns: [{ role: 'user', parts: ['healthyneedle'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath(), alternative] },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  ownIndexer(subject)
  await subject.start()
  await finishPendingObservation(subject)
  await rename(dbPath(), `${dbPath()}.saved`)
  await writeFile(dbPath(), 'temporarily unreadable sqlite')
  appendOpenCodeSqliteTurn(alternative, 'ses_alternative', {
    role: 'assistant',
    parts: ['healthyupdateneedle']
  })
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'preservedneedle' }).hits).toHaveLength(1)
  expect(openEngine().search({ query: 'healthyupdateneedle' }).hits).toHaveLength(1)
  await rm(dbPath())
  await rename(`${dbPath()}.saved`, dbPath())
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_old_import', turns: [{ role: 'user', parts: ['recoveredprimaryneedle'] }] }
  ])
  const imported = new SyncDatabase(dbPath())
  imported
    .prepare("UPDATE session SET time_created=1000,time_updated=2000 WHERE id='ses_old_import'")
    .run()
  imported.close()
  clock.advance(20000)
  await subject.settled()
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'recoveredprimaryneedle' }).hits[0]?.sessionId).toBe(
    'ses_old_import'
  )
  expect(openEngine().search({ query: 'preservedneedle' }).hits).toHaveLength(1)
})

it('keeps full membership proofs separate when v1 and v2 share one physical database', async () => {
  writeVault()
  const subject = await startIndexer()
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
  const db = new SyncDatabase(dbPath())
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('ses_capture', 1740000000000, 1740000010000)`)
  db.close()
  const changed = new SyncDatabase(dbPath())
  changed.prepare('DELETE FROM session WHERE id=?').run(SESSION)
  changed.close()
  await subject.reconcile({ full: true })
  await finishPendingObservation(subject)
  // The v2 copy of this ID is not positive membership evidence for the removed v1 row.
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(0)
  expect(openEngine().search({ query: OTHER }).hits).toHaveLength(1)
})

it('keeps indexed rows when an existing physical database becomes empty or unrecognized', async () => {
  writeVault()
  const subject = await startIndexer()
  const db = new SyncDatabase(dbPath())
  db.exec('DELETE FROM session')
  db.close()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
  const changed = new SyncDatabase(dbPath())
  changed.exec('DROP TABLE session')
  changed.close()
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: ANSWER }).hits).toHaveLength(1)
})

it.each([40, 400])(
  'acknowledges one complete full observation of an actively changing %s-row database',
  async (population) => {
    writeOpenCodeSqliteDatabase(
      dbPath(),
      Array.from({ length: population }, (_, index) => ({
        id: `ses_${index}`,
        turns: [{ role: 'user', parts: ['activearchive'] }]
      }))
    )
    openCodeObservation.hook = (agent) => {
      if (agent === 'opencode') {
        appendOpenCodeSqliteTurn(dbPath(), 'ses_0', {
          role: 'assistant',
          parts: ['activewalneedle']
        })
      }
    }
    const subject = await startIndexer()
    for (let cycle = 0; cycle < 5; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(
      openCodeListObservations.filter((observation) => observation.limit === Infinity)
    ).toHaveLength(1)
    expect(
      openCodeListObservations
        .filter((observation) => observation.limit === 12)
        .every((observation) => observation.rows <= 12)
    ).toBe(true)
    expect(openEngine().search({ query: 'activewalneedle' }).hits[0]?.sessionId).toBe('ses_0')
    openCodeObservation.hook = null
    await subject.reconcile({ full: true })
    await finishPendingObservation(subject)
    expect(subject.status().phase).toBe('current')
  }
)

it('chooses the original earlier database when an equal-time alias is imported later', async () => {
  const alternative = join(harness.root, 'opencode-db', 'opencode-alternative.db')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_other', turns: [{ role: 'user', parts: ['otherrow'] }] }
  ])
  writeOpenCodeSqliteDatabase(alternative, [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['laterdatabasecopy'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: { ...harness.roots, opencodeDbPaths: [dbPath(), alternative] },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  ownIndexer(subject)
  await subject.start()
  await finishPendingObservation(subject)
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits[0]?.sessionId).toBe('ses_shared')
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_shared', turns: [{ role: 'user', parts: ['earlierdatabasecopy'] }] }
  ])
  await subject.reconcile({ full: true })
  expect(openEngine().search({ query: 'earlierdatabasecopy' }).hits[0]?.sessionId).toBe(
    'ses_shared'
  )
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits).toHaveLength(0)
  // Opening the retained raw alias still parses it for History, without republishing search output.
  const foreground = await readWholeTranscript({
    candidate: {
      agent: 'opencode',
      codexHome: null,
      file: {
        path: buildOpenCodeSqliteCandidatePath(alternative, 'ses_shared'),
        mtimeMs: 1740000060000,
        modifiedAt: '2025-02-19T21:21:00.000Z'
      }
    },
    platform: process.platform
  })
  await subject.settled()
  expect(foreground?.sessionId).toBe('ses_shared')
  expect(openEngine().search({ query: 'laterdatabasecopy' }).hits).toHaveLength(0)
})

it('settles a healthy physical full list when another family reports a concurrent refusal', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_healthy', turns: [{ role: 'user', parts: ['healthysourcecopy'] }] }
  ])
  let announceOther!: () => void, releaseOther!: () => void
  const otherStarted = new Promise<void>((resolve) => {
    announceOther = resolve
  })
  const otherReleased = new Promise<void>((resolve) => {
    releaseOther = resolve
  })
  openCodeObservation.hook = async (agent, issues) => {
    if (agent === 'opencode2') {
      issues.push({
        agent: 'opencode2',
        path: dbPath(),
        message: 'fixture refused family'
      })
      announceOther()
      await otherReleased
    } else {
      await otherStarted
      releaseOther()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const subject = await startIndexer({ degraded: true })
  openCodeObservation.hook = null
  clock.advance(20000)
  await subject.settled()
  expect(openEngine().search({ query: 'healthysourcecopy' }).hits[0]?.sessionId).toBe('ses_healthy')
  expect(
    openCodeListObservations.filter(
      ({ paths, limit }) => limit === Infinity && paths.includes(dbPath())
    )
  ).toHaveLength(1)
})

it('parks a persistently partial physical observation and wakes it on an explicit full request', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_recoverable', turns: [{ role: 'user', parts: ['recoverabledatabase'] }] }
  ])
  openCodeObservation.hook = (agent, issues) => {
    if (agent === 'opencode') {
      issues.push({ agent: 'opencode', path: dbPath(), message: 'fixture partial read' })
    }
  }
  const subject = await startIndexer({ degraded: true })
  for (let cycle = 0; cycle < 6; cycle++) {
    clock.advance(20000)
    await subject.settled()
  }
  expect(subject.status()).toMatchObject({ phase: 'degraded', filesDue: 0 })
  expect(
    openCodeListObservations.filter(
      ({ paths, limit }) => limit === Infinity && paths.includes(dbPath())
    )
  ).toHaveLength(3)
  expect(subject.status().lastSweepCompletedAt).not.toBeNull()
  expect(openEngine().search({ query: 'recoverabledatabase' }).hits[0]?.sessionId).toBe(
    'ses_recoverable'
  )
  openCodeObservation.hook = null
  await subject.reconcile({ full: true })
  await finishPendingObservation(subject)
  expect(subject.status().phase).toBe('current')
  expect(
    openCodeListObservations.filter(
      ({ paths, limit }) => limit === Infinity && paths.includes(dbPath())
    )
  ).toHaveLength(4)
  expect(openEngine().search({ query: 'recoverabledatabase' }).hits[0]?.sessionId).toBe(
    'ses_recoverable'
  )
})

it('retains a restored old row when a family listing loses the earlier absence proof', async () => {
  const removed = Array.from({ length: 512 }, (_, index) => ({
    id: `ses_removed_${index}`,
    turns: [{ role: 'user' as const, parts: ['removedarchive'] }]
  }))
  writeOpenCodeSqliteDatabase(dbPath(), [
    ...removed,
    { id: 'ses_restored', turns: [{ role: 'user', parts: ['restoredoldneedle'] }] },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `ses_keeper_${index}`,
      turns: [{ role: 'user' as const, parts: ['keeperarchive'] }]
    }))
  ])
  const source = new SyncDatabase(dbPath())
  source.prepare("UPDATE session SET time_updated=1740000000001 WHERE id='ses_restored'").run()
  source.close()
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: {
      ...harness.roots,
      opencodeDbPaths: undefined,
      opencodeStorageDir: join(dirname(dbPath()), 'storage')
    },
    historyDays: null,
    clock,
    discoveryDeadlineMs: 0,
    fullSweepEveryCycles: 1000
  })
  ownIndexer(subject)
  await subject.start()
  await finishPendingObservation(subject)
  expect(subject.status().filesIndexed).toBe(533)
  expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  for (let cycle = 0; cycle < 8; cycle++) {
    clock.advance(20000)
    await subject.settled()
  }
  expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  const changed = new SyncDatabase(dbPath())
  changed.exec(
    "CREATE TABLE saved_session AS SELECT * FROM session WHERE id='ses_restored'; DELETE FROM session WHERE id NOT LIKE 'ses_keeper_%'"
  )
  changed.close()
  await subject.reconcile({ full: true })
  // The first bounded retirement batch leaves this older row owed.
  expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  const restored = new SyncDatabase(dbPath())
  restored.exec('INSERT INTO session SELECT * FROM saved_session')
  restored.close()
  const actual = filesystem.wslGatedReaddir
  let refused = false
  const listing = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
    if (path === dirname(dbPath()) && !refused) {
      refused = true
      return Promise.reject(
        Object.assign(new Error('fixture family listing refusal'), { code: 'EIO' })
      )
    }
    return actual(path, ...rest)
  })
  try {
    clock.advance(20000)
    await subject.settled()
    expect(refused).toBe(true)
    expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
    await subject.reconcile({ full: true })
    expect(openEngine().search({ query: 'restoredoldneedle' }).hits).toHaveLength(1)
  } finally {
    listing.mockRestore()
  }
})

it('settles a full attempt blocked by persistent family enumeration while retaining recovery', async () => {
  writeOpenCodeSqliteDatabase(dbPath(), [
    { id: 'ses_family', turns: [{ role: 'user', parts: ['retainedfamilyneedle'] }] }
  ])
  const subject = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: {
      ...harness.roots,
      opencodeDbPaths: undefined,
      opencodeStorageDir: join(dirname(dbPath()), 'storage')
    },
    historyDays: null,
    clock,
    fullSweepEveryCycles: 1000
  })
  ownIndexer(subject)
  await subject.start()
  const completed = subject.status().lastSweepCompletedAt
  expect(openEngine().search({ query: 'retainedfamilyneedle' }).hits).toHaveLength(1)
  const actual = filesystem.wslGatedReaddir
  let refused = true
  const reads = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
    if (refused && path === dirname(dbPath())) {
      return Promise.reject(Object.assign(new Error('fixture family refusal'), { code: 'EACCES' }))
    }
    return actual(path, ...rest)
  })
  try {
    clock.costPerNowMs = 1
    await subject.reconcile({ full: true })
    for (let cycle = 0; cycle < 6; cycle++) {
      clock.advance(20000)
      await subject.settled()
    }
    expect(subject.status().lastSweepCompletedAt).not.toBe(completed)
    expect(openEngine().search({ query: 'retainedfamilyneedle' }).hits).toHaveLength(1)
    refused = false
    appendOpenCodeSqliteTurn(dbPath(), 'ses_family', {
      role: 'assistant',
      parts: ['recoveredfamilyneedle']
    })
    await subject.reconcile({ full: true })
    await finishPendingObservation(subject)
    expect(openEngine().search({ query: 'recoveredfamilyneedle' }).hits).toHaveLength(1)
    expect(subject.status().phase).toBe('current')
  } finally {
    reads.mockRestore()
  }
})

it.each(['absent', 'positive', 'released'] as const)(
  'retains interrupted deletion through unavailable history until %s evidence accepts it',
  async (successor) => {
    writeOpenCodeSqliteDatabase(dbPath(), [
      { id: 'ses_owed', turns: [{ role: 'user', parts: ['owedoldneedle'] }] },
      { id: 'ses_keeper', turns: [{ role: 'user', parts: ['owedkeeperneedle'] }] }
    ])
    const errors: unknown[] = []
    const subject = new SessionSearchIndexer({
      databasePath: harness.databasePath,
      roots: {
        ...harness.roots,
        opencodeDbPaths: undefined,
        opencodeStorageDir: join(dirname(dbPath()), 'storage')
      },
      historyDays: null,
      clock,
      fullSweepEveryCycles: 1000,
      onError: (error) => errors.push(error)
    })
    ownIndexer(subject)
    await subject.start()
    await finishPendingObservation(subject)
    expect(openEngine().search({ query: 'owedoldneedle' }).hits).toHaveLength(1)
    const changed = new SyncDatabase(dbPath())
    changed.exec(
      "CREATE TABLE saved_session AS SELECT * FROM session WHERE id='ses_owed'; DELETE FROM session WHERE id='ses_owed'"
    )
    changed.close()
    const request = SessionSearchWorkerClient.prototype.request
    let block = true,
      rejected = false,
      fullFault = false,
      faulted = false
    const handoff = vi
      .spyOn(SessionSearchWorkerClient.prototype, 'request')
      .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
        if (
          block &&
          command.op === 'candidates' &&
          command.command.kind === 'remove-page' &&
          command.command.rows.some((row) => row.containers?.length)
        ) {
          rejected = true
          throw new SessionSearchOperationError('fixture omission transfer refused')
        }
        if (
          fullFault &&
          !faulted &&
          command.op === 'catalog' &&
          command.command.kind === 'container-retire' &&
          command.command.authority === 'full'
        ) {
          faulted = true
          if (successor === 'absent') {
            await request.call(this, command)
          }
          throw new SessionSearchOperationError('fixture full authority response refused')
        }
        return request.call(this, command)
      })
    const actual = filesystem.wslGatedReaddir
    let unavailable = false
    const listing = vi.spyOn(filesystem, 'wslGatedReaddir').mockImplementation((path, ...rest) => {
      if (unavailable && path === dirname(dbPath())) {
        return Promise.reject(
          Object.assign(new Error('fixture source unavailable'), { code: 'EIO' })
        )
      }
      return actual(path, ...rest)
    })
    try {
      await subject.reconcile({ full: true })
      expect(rejected).toBe(true)
      expect(errors.some((error) => error instanceof SessionSearchOperationError)).toBe(true)
      unavailable = true
      block = false
      for (let cycle = 0; cycle < 6; cycle++) {
        clock.advance(20000)
        await subject.settled()
      }
      expect(subject.status()).toMatchObject({ phase: 'degraded', filesDue: 0 })
      expect(openEngine().search({ query: 'owedoldneedle' }).hits).toHaveLength(1)
      expect(openEngine().search({ query: 'owedkeeperneedle' }).hits).toHaveLength(1)
      if (successor === 'positive') {
        const restored = new SyncDatabase(dbPath())
        restored.exec('INSERT INTO session SELECT * FROM saved_session')
        restored.close()
        appendOpenCodeSqliteTurn(dbPath(), 'ses_owed', {
          role: 'assistant',
          parts: ['owednewneedle']
        })
      } else if (successor === 'released') {
        await rm(dbPath())
      }
      unavailable = false
      fullFault = successor !== 'released'
      await subject.reconcile({ full: true })
      expect(faulted).toBe(successor !== 'released')
      await finishPendingObservation(subject)
      expect(openEngine().search({ query: 'owedoldneedle' }).hits).toHaveLength(
        successor === 'positive' ? 1 : 0
      )
      expect(openEngine().search({ query: 'owednewneedle' }).hits).toHaveLength(
        successor === 'positive' ? 1 : 0
      )
      expect(openEngine().search({ query: 'owedkeeperneedle' }).hits).toHaveLength(
        successor === 'released' ? 0 : 1
      )
      expect(subject.status().phase).toBe('current')
    } finally {
      handoff.mockRestore()
      listing.mockRestore()
    }
  }
)
