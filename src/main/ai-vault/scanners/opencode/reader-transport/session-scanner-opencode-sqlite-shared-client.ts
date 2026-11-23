import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import { locateForeignSqliteReaderEntry } from '../../../../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'

// The one native OpenCode/Hermes SQLite reader; WSL distros have their own.
let sharedClient: Promise<OpenCodeSqliteWorkerClient> | null = null
let reportedMissingBundle = false

// The entry is located with async fs, so no read waits on a synchronous probe of the bundle. A missing
// bundle fails this read and is looked for again on the next, so a restored bundle recovers.
export function getNativeOpenCodeSqliteClient(): Promise<OpenCodeSqliteWorkerClient> {
  if (sharedClient) {
    return sharedClient
  }
  const pending = locateForeignSqliteReaderEntry(__dirname).then((workerPath) => {
    if (!workerPath && sharedClient === pending) {
      sharedClient = null
    }
    if (workerPath) {
      reportedMissingBundle = false
    }
    return new OpenCodeSqliteWorkerClient({
      // Each read builds a fresh client while the bundle is missing; say so once until it returns.
      ...(workerPath ? {} : { log: reportMissingBundleOnce }),
      workerFactory: () => {
        if (!workerPath) {
          throw new Error(`OpenCode SQLite worker entry not found under ${__dirname}`)
        }
        return spawnWorkerThread(workerPath, { name: 'orca-opencode-sqlite-reader' })
      }
    })
  })
  sharedClient = pending
  return pending
}

function reportMissingBundleOnce(message: string): void {
  if (!reportedMissingBundle) {
    reportedMissingBundle = true
    console.warn(message)
  }
}
