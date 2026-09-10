import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  writeMessageGraphTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

/*
 * The lifecycle matrix: every operation a caller can perform, against every
 * shape an unreachable root takes, against both ways discovery reports a root.
 *
 * What each cell asserts:
 *   A. No row is retired for a file that still exists. A `clear()` is the one
 *      exception, and it is stated per operation rather than excused.
 *   B. The unreachable root is named in `degradedRoots`, by a real directory
 *      path — never the delimiter-joined label a merged discovery reports.
 *   C. The phase is never `current` while a root is degraded.
 *   D. Once the root is reachable again, a sweep indexes everything under it.
 *
 * Round 6 ran this as a throwaway harness on the previous design; it lives in
 * the repository now. Two of its shapes changed with the stateless walk. The
 * "present but empty mountpoint" shape is gone, because a readable root that
 * lists nothing is no longer treated as unreachable — that is a root the user
 * emptied, and `session-search-deleted-sources.ts` states the trade. In its
 * place is a root whose transcripts sit behind an unreadable subdirectory,
 * which is the partial-tree case the old shape never covered.
 */

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0
const INTERVAL_MS = 20_000
const SESSIONS = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']

type RootShape = {
  name: string
  /** Where the unreachable root's transcripts live, and where its files go. */
  detachedRoot: (harness: SessionSearchIndexerHarness) => string
  detachedFile: (harness: SessionSearchIndexerHarness, session: string) => string
  writeDetached: (path: string, session: string) => Promise<void>
  healthyFile: (harness: SessionSearchIndexerHarness, session: string) => string
  writeHealthy: (path: string, session: string) => Promise<void>
}

const OPENCLAW_SESSION_DIR = join('agents', 'main', 'sessions')

const ROOT_SHAPES: RootShape[] = [
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

type UnreachableShape = {
  name: string
  needsDeniedRead: boolean
  /**
   * Whether an empty index can see this at all. Reading the root itself is the
   * one probe a pass makes with no rows to go on: a root that answers ENOENT is
   * what an uninstalled agent answers too, and a readable root with an
   * unreadable subdirectory is swallowed by the file walker, which returns
   * rather than reporting. Both are invisible until the index holds a row under
   * the root, which is the evidence the retirement walk runs on.
   */
  visibleWithNoRows: boolean
  detach: (root: string, transcriptDir: string, parked: string) => Promise<void>
  attach: (root: string, transcriptDir: string, parked: string) => Promise<void>
}

const UNREACHABLE_SHAPES: UnreachableShape[] = [
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
  /** True when the operation throws the index away, so no row survives it. */
  clearsIndex?: boolean
  /** Healthy-root sessions the operation deletes from disk. */
  deletes?: readonly string[]
  run: (context: MatrixContext) => Promise<void>
}

const OPERATIONS: Operation[] = [
  { name: 'one cycle', run: (context) => context.cycle() },
  {
    name: 'pause and resume',
    run: async (context) => {
      context.indexer().pause()
      await context.indexer().resume()
    }
  },
  {
    name: 'close and restart',
    run: async (context) => {
      await context.restart()
    }
  },
  {
    name: 'clear and rebuild',
    clearsIndex: true,
    run: (context) => context.indexer().clear()
  },
  {
    name: 'history narrowed then widened',
    run: async (context) => {
      await context.indexer().setHistoryDays(30)
      await context.indexer().setHistoryDays(null)
    }
  },
  {
    name: 'an indexed path invalidated',
    run: async (context) => {
      context.indexer().invalidate([context.detachedPaths[0] ?? ''])
      await context.cycle()
    }
  },
  {
    name: 'a path the index never held invalidated',
    run: async (context) => {
      context.indexer().invalidate([join(context.detachedRoot, 'never-indexed.jsonl')])
      await context.cycle()
    }
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
      // Twice: a root that goes from holding transcripts to holding none in one
      // pass is unverifiable for that pass, so the second is the proving one.
      await context.indexer().reconcile({ full: true })
      await context.indexer().reconcile({ full: true })
    }
  },
  {
    name: 'two cycles',
    run: async (context) => {
      await context.cycle()
      await context.cycle()
    }
  }
]

type MatrixContext = {
  indexer: () => SessionSearchIndexer
  restart: () => Promise<void>
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

function open(): SessionSearchIndexer {
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    reconcileIntervalMs: INTERVAL_MS,
    pace: async () => undefined
  })
  return indexer
}

/** Session ids the index answers for, whichever agent wrote them. */
function indexedSessions(): string[] {
  return harness
    .read(
      (db: SyncDatabase) =>
        db.prepare('SELECT session_id AS id FROM visible_sessions').all() as { id: string }[]
    )
    .map((row) => row.id)
    .sort()
}

for (const roots of ROOT_SHAPES) {
  for (const unreachable of UNREACHABLE_SHAPES) {
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

            await open().start()
            const detachedIds = detachedPaths.map((_path, index) =>
              roots === ROOT_SHAPES[0]
                ? fullSessionId(SESSIONS[index] ?? '')
                : (SESSIONS[index] ?? '')
            )
            const healthyIds = SESSIONS.map((session) => session)
            expect(indexedSessions()).toEqual([...detachedIds, ...healthyIds].sort())
            // One cycle so the watch set holds the recency window, which is the
            // state a running indexer is in when a volume goes away.
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
                restart: async () => {
                  indexer?.close()
                  resetTranscriptConsumersForTests()
                  resetSessionParseCacheForTests()
                  await open().start()
                },
                cycle: async () => {
                  clock.advance(INTERVAL_MS)
                  await indexer?.settled()
                },
                detachedRoot,
                detachedPaths
              })

              // A: nothing that still exists lost its rows.
              const survivingDetached = operation.clearsIndex ? [] : detachedIds
              expect(indexedSessions()).toEqual([...survivingDetached, ...kept].sort())

              const status = indexer?.status()
              const degraded = status?.degradedRoots.map((root) => root.root) ?? []
              // With no rows under it, the only thing a pass can go on is
              // whether the root itself refuses to list.
              if (operation.clearsIndex && !unreachable.visibleWithNoRows) {
                expect(degraded).not.toContain(detachedRoot)
              } else {
                // B: named, by a real directory rather than a joined label.
                expect(degraded).toContain(detachedRoot)
                expect(degraded.every((root) => !root.includes(delimiter))).toBe(true)
                // C: not current while a root is degraded.
                expect(status?.phase).not.toBe('current')
              }
            } finally {
              await unreachable.attach(detachedRoot, transcriptDir, parked)
            }

            // D: reachable again, a sweep reads the whole tree back.
            await mkdir(dirname(healthyPaths[0] ?? ''), { recursive: true })
            await indexer?.reconcile({ full: true })
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
