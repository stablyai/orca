import { open, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import { getAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'
import { orchestrationDbFile } from '../orchestration-db-file'

const MIN_FREE_BYTES = 32 * 1024 * 1024
const MIN_FREE_FRACTION = 0.25

type PageCounts = { pageSize: number; pages: number; freePages: number }

export type OrchestrationDbCompaction =
  | { kind: 'not-needed' }
  | { kind: 'low-disk'; neededBytes: number; availableBytes: number }
  | { kind: 'busy' }
  | { kind: 'compacted'; beforeBytes: number; afterBytes: number; ms: number }
  | { kind: 'failed'; error: string }

/** Files made before incremental auto-vacuum keep freed pages forever; worth one VACUUM only when much is free. */
function isCompactionWarranted({ pageSize, pages, freePages }: PageCounts): boolean {
  return freePages * pageSize >= MIN_FREE_BYTES && freePages >= pages * MIN_FREE_FRACTION
}

// Evaluated source, as the checkpoint worker. Re-reads the counts under SQLite's own view (WAL included).
const compactionWorkerSource = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename);
const pragma = (name) => Object.values(db.prepare('PRAGMA ' + name).get())[0];
const started = performance.now();
try {
  // Never wait: any other connection means Orca is not alone with the file, so retry next launch.
  db.exec('PRAGMA busy_timeout = 0');
  const pageSize = pragma('page_size');
  const counts = { pageSize, pages: pragma('page_count'), freePages: pragma('freelist_count') };
  const warranted =
    counts.freePages * pageSize >= workerData.minFreeBytes &&
    counts.freePages >= counts.pages * workerData.minFreeFraction;
  if (pragma('auto_vacuum') !== 0 || !warranted) {
    parentPort.postMessage({ kind: 'not-needed' });
  } else {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    parentPort.postMessage({
      kind: 'compacted',
      beforeBytes: counts.pages * pageSize,
      afterBytes: pragma('page_count') * pageSize,
      ms: Math.round(performance.now() - started)
    });
  }
} catch (error) {
  const code = (error && error.errcode) & 0xff;
  parentPort.postMessage(
    code === 5 || code === 6 ? { kind: 'busy' } : { kind: 'failed', error: String(error) }
  );
} finally {
  db.close();
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
  const counts = await readHeaderCounts(filename)
  if (!counts || !isCompactionWarranted(counts)) {
    return { kind: 'not-needed' }
  }
  // VACUUM writes a full copy through the WAL before the old pages go.
  const neededBytes = 2 * counts.pages * counts.pageSize
  const disk = await statfs(dirname(filename))
  const availableBytes = Number(disk.bavail) * Number(disk.bsize)
  if (availableBytes < neededBytes) {
    return { kind: 'low-disk', neededBytes, availableBytes }
  }
  return new Promise((resolve) => {
    let worker: ReturnType<typeof spawnWorkerThread>
    try {
      worker = spawnWorkerThread(compactionWorkerSource, {
        name: 'orca-orchestration-compaction',
        eval: true,
        workerData: {
          filename,
          minFreeBytes: MIN_FREE_BYTES,
          minFreeFraction: MIN_FREE_FRACTION
        }
      })
    } catch (error) {
      resolve({ kind: 'failed', error: String(error) })
      return
    }
    worker.once('message', resolve)
    worker.once('error', (error) => resolve({ kind: 'failed', error: String(error) }))
    worker.once('exit', () => resolve({ kind: 'failed', error: 'worker exited without a result' }))
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
