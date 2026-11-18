import { open, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnProcess } from '@orca/process-host'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Quit waits at most QUIT_BUDGET_MS; larger files rarely finish inside it.
const MAX_LIVE_BYTES = 256 * MIB
const QUIT_BUDGET_MS = 2_000
const EXIT_GRACE_MS = 500

/** Work another agent or process may still finish; compaction waits for a quit with none. */
export const ACTIVE_ORCHESTRATION_WORK_SQL = `SELECT
  EXISTS(SELECT 1 FROM dispatch_contexts WHERE status IN ('pending', 'dispatched'))
  OR EXISTS(SELECT 1 FROM worker_dispatches
    WHERE state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned'))
  OR EXISTS(SELECT 1 FROM worker_terminal_resources
    WHERE release_state IN ('requested', 'releasing', 'unknown')) AS active`

type PageCounts = { pageSize: number; pages: number; freePages: number }

export type OrchestrationDbCompaction =
  | { kind: 'not-needed' }
  | { kind: 'active' }
  | { kind: 'too-large'; liveBytes: number }
  | { kind: 'low-disk'; neededBytes: number; availableBytes: number }
  | { kind: 'busy' }
  | { kind: 'timed-out'; ms: number }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

/** Files made before incremental auto-vacuum keep freed pages forever; worth one VACUUM only when much is free. */
function isCompactionWarranted({ pageSize, pages, freePages }: PageCounts): boolean {
  return freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
}

// Run as a node child, not a worker thread: only a process can be stopped in the middle of a VACUUM.
// Decides on SQLite's own counts (WAL included), under an exclusive lock, and prints one JSON line.
const compactionChildSource = `
const { DatabaseSync } = require('node:sqlite');
const { statfsSync } = require('node:fs');
const { dirname } = require('node:path');
const w = JSON.parse(process.env.ORCA_ORCHESTRATION_COMPACTION);
const report = (result) => process.stdout.write(JSON.stringify(result) + '\\n');
const available = (dir) => {
  try {
    const disk = statfsSync(dir);
    return Number(disk.bavail) * Number(disk.bsize);
  } catch {
    return 0;
  }
};
const started = performance.now();
let db;
try {
  db = new DatabaseSync(w.filename);
  const pragma = (name) => Object.values(db.prepare('PRAGMA ' + name).get())[0];
  // Fails at once if any other connection, in any process, has the file open.
  db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
  const pageSize = pragma('page_size');
  const pages = pragma('page_count');
  const freePages = pragma('freelist_count');
  const fileBytes = pages * pageSize;
  const liveBytes = (pages - freePages) * pageSize;
  const warranted =
    freePages * pageSize >= w.minFreeBytes && freePages >= pages * w.minFreeFraction;
  if (pragma('auto_vacuum') !== 0 || !warranted) {
    report({ kind: 'not-needed' });
  } else if (db.prepare(w.activeWorkSql).get().active) {
    // Rechecked under the lock: another process may have started work since the runtime looked.
    report({ kind: 'active' });
  } else if (liveBytes > w.maxLiveBytes) {
    report({ kind: 'too-large', liveBytes });
  } else {
    // VACUUM builds the copy in the temp directory, then writes it through the WAL beside the file.
    const neededBytes = 2 * fileBytes;
    const availableBytes = available(dirname(w.filename));
    if (availableBytes < neededBytes || available(w.tempDir) < liveBytes) {
      report({ kind: 'low-disk', neededBytes, availableBytes });
    } else {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      report({
        kind: 'compacted',
        beforeBytes: fileBytes,
        afterBytes: pragma('page_count') * pageSize,
        ms: Math.round(performance.now() - started)
      });
    }
  }
} catch (error) {
  const code = (error && error.errcode) & 0xff;
  report(code === 5 || code === 6 ? { kind: 'busy' } : { kind: 'failed', error: String(error) });
} finally {
  db?.close();
}
`

/** Where SQLite builds VACUUM's copy: it honors SQLITE_TMPDIR first. */
function sqliteTempDir(): string {
  return process.env.SQLITE_TMPDIR || tmpdir()
}

async function availableBytesIn(dir: string): Promise<number> {
  try {
    const disk = await statfs(dir)
    return Number(disk.bavail) * Number(disk.bsize)
  } catch {
    return 0
  }
}

/** The page counts in a SQLite header; null when the file is missing or not a database. */
async function readHeaderCounts(filename: string): Promise<PageCounts | null> {
  let file
  try {
    file = await open(filename, 'r')
  } catch {
    return null
  }
  try {
    const header = Buffer.alloc(100)
    const { bytesRead } = await file.read(header, 0, 100, 0)
    if (bytesRead < 100 || header.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
      return null
    }
    // A nonzero largest-root-page field means auto-vacuum is already on.
    if (header.readUInt32BE(52) !== 0) {
      return null
    }
    const rawPageSize = header.readUInt16BE(16)
    return {
      pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
      pages: header.readUInt32BE(28),
      freePages: header.readUInt32BE(36)
    }
  } finally {
    await file.close()
  }
}

function readChildResult(output: string): OrchestrationDbCompaction | null {
  try {
    const parsed: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '')
    return typeof parsed === 'object' && parsed !== null && 'kind' in parsed
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by compactionChildSource above.
        (parsed as OrchestrationDbCompaction)
      : null
  } catch {
    return null
  }
}

/**
 * One VACUUM of an orchestration database made before incremental auto-vacuum, so it can return pages from
 * then on. The caller must hold no connection to the file. Stopped at `budgetMs`, which rolls it back; a busy,
 * active or stopped file is left for a later quit, and the switched file never qualifies again.
 */
export async function compactOrchestrationDb(
  filename: string,
  budgetMs = QUIT_BUDGET_MS
): Promise<OrchestrationDbCompaction> {
  // A cheap first look, so ordinary quits start no process; the child decides on SQLite's own view.
  const counts = await readHeaderCounts(filename)
  if (!counts || !isCompactionWarranted(counts)) {
    return { kind: 'not-needed' }
  }
  const liveBytes = (counts.pages - counts.freePages) * counts.pageSize
  if (liveBytes > MAX_LIVE_BYTES) {
    return { kind: 'too-large', liveBytes }
  }
  const neededBytes = 2 * counts.pages * counts.pageSize
  const availableBytes = await availableBytesIn(dirname(filename))
  if (availableBytes < neededBytes || (await availableBytesIn(sqliteTempDir())) < liveBytes) {
    return { kind: 'low-disk', neededBytes, availableBytes }
  }
  const started = performance.now()
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: process.execPath,
        args: ['-e', compactionChildSource],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({
            filename,
            tempDir: sqliteTempDir(),
            minFreeBytes: MIN_FREE_BYTES,
            minFreeFraction: MIN_FREE_FRACTION,
            maxLiveBytes: MAX_LIVE_BYTES,
            activeWorkSql: ACTIVE_ORCHESTRATION_WORK_SQL
          })
        },
        stdio: 'pipe'
      })
    } catch (error) {
      resolve({ kind: 'failed', error: String(error) })
      return
    }
    let output = ''
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    let grace: NodeJS.Timeout | undefined
    const finish = (result: OrchestrationDbCompaction): void => {
      clearTimeout(budget)
      clearTimeout(grace)
      resolve(result)
    }
    // Killing it rolls the VACUUM back; quit then waits briefly for the lock to drop, never longer.
    const budget = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      grace = setTimeout(
        () => finish({ kind: 'timed-out', ms: Math.round(performance.now() - started) }),
        EXIT_GRACE_MS
      )
    }, budgetMs)
    child.once('error', (error) => finish({ kind: 'failed', error: String(error) }))
    child.once('close', () =>
      finish(
        timedOut
          ? { kind: 'timed-out', ms: Math.round(performance.now() - started) }
          : (readChildResult(output) ?? { kind: 'failed', error: 'no result from compaction' })
      )
    )
  })
}

export type OrchestrationDbQuitOwner = {
  /** Closes the runtime's connection when no orchestration work is in flight; the file, or null to skip. */
  closeOrchestrationDbForQuit(): string | null
}

/** Last step of a clean quit, after every other teardown settled: nothing can open the file again. */
export async function compactOrchestrationDbAtQuit(
  owner: OrchestrationDbQuitOwner | null | undefined
): Promise<void> {
  try {
    const filename = owner?.closeOrchestrationDbForQuit()
    if (!filename) {
      return
    }
    const result = await compactOrchestrationDb(filename)
    if (result.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', result.error)
    } else if (result.kind !== 'not-needed') {
      console.info('[orchestration] database compaction', result)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
