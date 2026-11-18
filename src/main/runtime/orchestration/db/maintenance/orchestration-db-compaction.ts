import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import { getAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'
import { orchestrationDbFile } from '../orchestration-db-file'

const MIB = 1024 * 1024
const MIN_FREE_BYTES = 32 * MIB
const MIN_FREE_FRACTION = 0.25
// Launch waits for the rewrite; this keeps it within seconds on slow disks and well inside remote readiness deadlines.
const MAX_LIVE_BYTES = 512 * MIB

type PageCounts = { pageSize: number; pages: number; freePages: number }

export type OrchestrationDbCompaction =
  | { kind: 'not-needed' }
  | { kind: 'too-large'; liveBytes: number }
  | { kind: 'low-disk'; neededBytes: number; availableBytes: number }
  | { kind: 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

/** Files made before incremental auto-vacuum keep freed pages forever; worth one VACUUM only when much is free. */
function isCompactionWarranted({ pageSize, pages, freePages }: PageCounts): boolean {
  return freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
}

// Evaluated source, as the checkpoint worker. Decides on SQLite's own counts (WAL included), under an exclusive lock.
const compactionWorkerSource = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { statfsSync } = require('node:fs');
const { dirname } = require('node:path');
const w = workerData;
const available = (dir) => {
  const disk = statfsSync(dir);
  return Number(disk.bavail) * Number(disk.bsize);
};
const started = performance.now();
let db;
try {
  db = new DatabaseSync(w.filename);
  const pragma = (name) => Object.values(db.prepare('PRAGMA ' + name).get())[0];
  // Fails at once if any other connection, in any process, has the file open; retried next launch.
  db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
  const pageSize = pragma('page_size');
  const pages = pragma('page_count');
  const freePages = pragma('freelist_count');
  const fileBytes = pages * pageSize;
  const liveBytes = (pages - freePages) * pageSize;
  const warranted =
    freePages * pageSize >= w.minFreeBytes && freePages >= pages * w.minFreeFraction;
  if (pragma('auto_vacuum') !== 0 || !warranted) {
    parentPort.postMessage({ kind: 'not-needed' });
  } else if (liveBytes > w.maxLiveBytes) {
    parentPort.postMessage({ kind: 'too-large', liveBytes });
  } else {
    // VACUUM builds the copy in the temp directory, then writes it through the WAL beside the file.
    const neededBytes = 2 * fileBytes;
    const availableBytes = available(dirname(w.filename));
    if (availableBytes < neededBytes || available(w.tempDir) < liveBytes) {
      parentPort.postMessage({ kind: 'low-disk', neededBytes, availableBytes });
    } else {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      parentPort.postMessage({
        kind: 'compacted',
        beforeBytes: fileBytes,
        afterBytes: pragma('page_count') * pageSize,
        ms: Math.round(performance.now() - started)
      });
    }
  }
} catch (error) {
  const code = (error && error.errcode) & 0xff;
  parentPort.postMessage(
    code === 5 || code === 6 ? { kind: 'busy' } : { kind: 'failed', error: String(error) }
  );
} finally {
  db?.close();
}
`

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

/**
 * One VACUUM of an orchestration database made before incremental auto-vacuum, so it can return
 * pages from then on. Runs before anything opens the file, on a worker thread; a busy file is
 * left for the next launch, and the switched file never qualifies again.
 */
export async function compactOrchestrationDbOnce(
  filename: string
): Promise<OrchestrationDbCompaction> {
  // A cheap first look, so ordinary launches start no worker; the worker decides on SQLite's own view.
  const counts = await readHeaderCounts(filename)
  if (!counts || !isCompactionWarranted(counts)) {
    return { kind: 'not-needed' }
  }
  return new Promise((resolve) => {
    let worker: ReturnType<typeof spawnWorkerThread>
    try {
      worker = spawnWorkerThread(compactionWorkerSource, {
        name: 'orca-orchestration-compaction',
        eval: true,
        workerData: {
          filename,
          tempDir: tmpdir(),
          minFreeBytes: MIN_FREE_BYTES,
          minFreeFraction: MIN_FREE_FRACTION,
          maxLiveBytes: MAX_LIVE_BYTES
        }
      })
    } catch (error) {
      resolve({ kind: 'failed', error: String(error) })
      return
    }
    let result: OrchestrationDbCompaction = {
      kind: 'failed',
      error: 'worker exited without a result'
    }
    worker.once('message', (message: OrchestrationDbCompaction) => {
      result = message
    })
    worker.once('error', (error) => {
      result = { kind: 'failed', error: String(error) }
    })
    // Only after exit has the worker closed the file, so the runtime can open it.
    worker.once('exit', () => resolve(result))
  })
}

export async function compactOrchestrationDbBeforeOpen(): Promise<void> {
  try {
    const result = await compactOrchestrationDbOnce(
      orchestrationDbFile(getAppEnvironment().getPath('userData'))
    )
    if (result.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', result.error)
    } else if (result.kind !== 'not-needed') {
      console.info('[orchestration] database compaction', result)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
