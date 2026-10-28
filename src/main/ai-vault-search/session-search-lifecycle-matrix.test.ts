import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import { removeSessionSearchDatabase } from './session-search-schema'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  writeMessageGraphTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const INTERVAL_MS = 20_000
const SESSIONS = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']

type RootLayout = {
  name: string
  detachedRoot: (harness: SessionSearchIndexerHarness) => string
  detachedFile: (harness: SessionSearchIndexerHarness, session: string) => string
  writeDetached: (path: string, session: string) => Promise<void>
  healthyFile: (harness: SessionSearchIndexerHarness, session: string) => string
  writeHealthy: (path: string, session: string) => Promise<void>
}

const OPENCLAW_SESSION_DIR = join('agents', 'main', 'sessions')

const ROOT_LAYOUTS: RootLayout[] = [
  {
    name: 'roots discovery reports one per directory',
    detachedRoot: (harness) => harness.roots.claudeProjectsDir ?? '',
    detachedFile: (harness, session) => join(harness.claudeProjectDir, `${session}.jsonl`),
    writeDetached: (path, session) =>
      writeClaudeTranscript(path, [`detached ${session}`], fullSessionId(session)),
    healthyFile: (harness, session) => join(harness.roots.piSessionsDir ?? '', `${session}.jsonl`),
    writeHealthy: (path, session) => writeMessageGraphTranscript(path, [`healthy ${session}`])
  },
  {
    name: 'roots a merged discovery joins into one label',
    detachedRoot: (harness) => join(harness.roots.openclawStateDir ?? '', 'agents'),
    detachedFile: (harness, session) =>
      join(harness.roots.openclawStateDir ?? '', OPENCLAW_SESSION_DIR, `${session}.jsonl`),
    writeDetached: (path, session) => writeMessageGraphTranscript(path, [`detached ${session}`]),
    healthyFile: (harness, session) =>
      join(harness.roots.openclawLegacyStateDir ?? '', OPENCLAW_SESSION_DIR, `${session}.jsonl`),
    writeHealthy: (path, session) => writeMessageGraphTranscript(path, [`healthy ${session}`])
  }
]

type UnreachableMode = {
  name: string
  needsDeniedRead: boolean
  /** Without indexed rows, only a root-level listing failure exposes this mode as degraded. */
  visibleWithNoRows: boolean
  detach: (root: string, transcriptDir: string, parked: string) => Promise<void>
  attach: (root: string, transcriptDir: string, parked: string) => Promise<void>
}

const UNREACHABLE_MODES: UnreachableMode[] = [
  {
    name: 'the root itself is not there',
    needsDeniedRead: false,
    visibleWithNoRows: false,
    detach: (root, _transcriptDir, parked) => rename(root, parked),
    attach: (root, _transcriptDir, parked) => rename(parked, root)
  },
  {
    name: 'the root refuses to list',
    needsDeniedRead: true,
    visibleWithNoRows: true,
    detach: (root) => chmod(root, 0o000),
    attach: (root) => chmod(root, 0o755)
  },
  {
    name: 'the transcripts sit behind a directory that refuses to list',
    needsDeniedRead: true,
    visibleWithNoRows: false,
    detach: (_root, transcriptDir) => chmod(transcriptDir, 0o000),
    attach: (_root, transcriptDir) => chmod(transcriptDir, 0o755)
  }
]

type Operation = {
  name: string
  clearsIndex?: boolean
  /** Healthy-root session IDs to delete before running the operation. */
  deletes?: readonly string[]
  options?: Partial<SessionSearchIndexerOptions>
  run: (context: MatrixContext) => Promise<void>
}

const OPERATIONS: Operation[] = [
  { name: 'one cycle', run: (context) => context.cycle() },
  {
    name: 'two cycles',
    run: async (context) => {
      await context.cycle()
      await context.cycle()
    }
  },
  {
    name: 'close and restart',
    run: (context) => context.reopen()
  },
  {
    name: 'two full reconciles',
    run: async (context) => {
      await context.indexer().reconcile({ full: true })
      await context.indexer().reconcile({ full: true })
    }
  },
  {
    name: 'one healthy transcript deleted',
    deletes: SESSIONS.slice(0, 1),
    run: (context) => context.cycle()
  },
  {
    name: 'every healthy transcript deleted',
    deletes: SESSIONS,
    run: async (context) => {
      // The first empty-root observation grants one pass of grace; the second can prove deletion.
      await context.indexer().reconcile({ full: true })
      await context.indexer().reconcile({ full: true })
    }
  },
  {
    name: 'the periodic sweep comes round',
    options: { fullSweepEveryCycles: 2 },
    run: async (context) => {
      await context.cycle()
      await context.cycle()
      await context.cycle()
    }
  },
  {
    name: 'every pass out of time at its first file',
    options: { passDeadlineMs: 0 },
    run: async (context) => {
      await context.cycle()
      await context.cycle()
    }
  },
  {
    // Fresh transcripts remain inside the narrower window, so reconstruction must preserve them.
    name: 'reconstructed for a narrower history window',
    run: (context) => context.reopen({ historyDays: 30 })
  },
  {
    name: 'the index thrown away and rebuilt',
    clearsIndex: true,
    run: (context) => context.reopen({ removeDatabase: true })
  }
]

type MatrixContext = {
  indexer: () => SessionSearchIndexer
  reopen: (args?: { historyDays?: number | null; removeDatabase?: boolean }) => Promise<void>
  cycle: () => Promise<void>
  detachedRoot: string
  detachedPaths: string[]
}

function fullSessionId(prefix: string): string {
  return `${prefix}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
}

let harness: SessionSearchIndexerHarness
let clock: FakeSessionSearchClock
let indexer: SessionSearchIndexer | null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  clock = new FakeSessionSearchClock()
  harness = await openSessionSearchIndexerHarness('ss-lifecycle')
  indexer = null
})

afterEach(async () => {
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function open(overrides: Partial<SessionSearchIndexerOptions> = {}): SessionSearchIndexer {
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    ...overrides
  })
  return indexer
}

/** Drive deadline-limited passes until session count stops increasing or maxCycles is reached. */
async function driveUntilIndexed(maxCycles: number): Promise<void> {
  let held = indexedSessions().length
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    clock.advance(INTERVAL_MS)
    await indexer?.settled()
    const now = indexedSessions().length
    if (now === held) {
      return
    }
    held = now
  }
}

function indexedSessions(): string[] {
  return harness
    .read(
      (db: SyncDatabase) =>
        db.prepare('SELECT session_id AS id FROM sessions').all() as { id: string }[]
    )
    .map((row) => row.id)
    .sort()
}

for (const roots of ROOT_LAYOUTS) {
  for (const unreachable of UNREACHABLE_MODES) {
    describe.skipIf(unreachable.needsDeniedRead && !CAN_DENY_READ)(
      `${roots.name}, ${unreachable.name}`,
      () => {
        for (const operation of OPERATIONS) {
          it(operation.name, async () => {
            const detachedRoot = roots.detachedRoot(harness)
            const detachedPaths = SESSIONS.map((session) => roots.detachedFile(harness, session))
            const healthyPaths = SESSIONS.map((session) => roots.healthyFile(harness, session))
            for (const [index, session] of SESSIONS.entries()) {
              await roots.writeDetached(detachedPaths[index] ?? '', session)
              await roots.writeHealthy(healthyPaths[index] ?? '', session)
            }
            const transcriptDir = dirname(detachedPaths[0] ?? '')
            const parked = join(harness.root, 'parked-root')

            await open(operation.options).start()
            await driveUntilIndexed(SESSIONS.length * 2)
            const detachedIds = detachedPaths.map((_path, index) =>
              roots === ROOT_LAYOUTS[0]
                ? fullSessionId(SESSIONS[index] ?? '')
                : (SESSIONS[index] ?? '')
            )
            const healthyIds = SESSIONS.map((session) => session)
            expect(indexedSessions()).toEqual([...detachedIds, ...healthyIds].sort())
            clock.advance(INTERVAL_MS)
            await indexer?.settled()

            await unreachable.detach(detachedRoot, transcriptDir, parked)
            try {
              const kept = SESSIONS.filter((session) => !operation.deletes?.includes(session))
              for (const session of operation.deletes ?? []) {
                await rm(healthyPaths[SESSIONS.indexOf(session)] ?? '')
              }
              await operation.run({
                indexer: () => indexer as SessionSearchIndexer,
                reopen: async (args = {}) => {
                  indexer?.close()
                  resetTranscriptConsumersForTests()
                  resetSessionParseCacheForTests()
                  if (args.removeDatabase === true) {
                    removeSessionSearchDatabase(harness.databasePath)
                  }
                  const overrides = { ...operation.options }
                  if ('historyDays' in args) {
                    overrides.historyDays = args.historyDays
                  }
                  await open(overrides).start()
                  await driveUntilIndexed(SESSIONS.length * 2)
                },
                cycle: async () => {
                  clock.advance(INTERVAL_MS)
                  await indexer?.settled()
                },
                detachedRoot,
                detachedPaths
              })

              const survivingDetached = operation.clearsIndex ? [] : detachedIds
              expect(indexedSessions()).toEqual([...survivingDetached, ...kept].sort())

              const status = indexer?.status()
              const degraded = status?.degradedRoots.map((root) => root.root) ?? []
              // After clearing the index, missing roots and unreadable subdirectories leave no evidence of degradation.
              if (operation.clearsIndex && !unreachable.visibleWithNoRows) {
                expect(degraded).not.toContain(detachedRoot)
              } else {
                expect(degraded).toContain(detachedRoot)
                expect(degraded.every((root) => !root.includes(delimiter))).toBe(true)
                expect(status?.phase).not.toBe('current')
              }
            } finally {
              await unreachable.attach(detachedRoot, transcriptDir, parked)
            }

            await mkdir(dirname(healthyPaths[0] ?? ''), { recursive: true })
            await indexer?.reconcile({ full: true })
            await driveUntilIndexed(SESSIONS.length * 2)
            expect(indexedSessions()).toEqual(
              [
                ...detachedIds,
                ...SESSIONS.filter((session) => !operation.deletes?.includes(session))
              ].sort()
            )
          })
        }
      }
    )
  }
}
