import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'
import { type ProfileStateBackupJob, writeProfileStateBackup } from './profile-state-backup-job'
import { isRecord } from './profile-state-document-validation'

const WORKER_FILENAME = 'profile-state-backup-worker-entry.js'
const BACKUP_TIMEOUT_MS = 10 * 60_000

export function resolveProfileStateBackupWorkerPath(moduleDir = __dirname): string {
  const entry = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(moduleDir), WORKER_FILENAME)
  // Rollup can place this launcher in a shared chunk beside the worker entries.
  return [entry, join(dirname(entry), '..', WORKER_FILENAME)].find(existsSync) ?? entry
}

/** Desktop validation runs off the UI thread; plain-Node backups retain the native async path. */
export function runProfileStateBackup(job: ProfileStateBackupJob): Promise<void> {
  return process.versions.electron ? runProfileStateBackupWorker(job) : writeProfileStateBackup(job)
}

export function runProfileStateBackupWorker(
  job: ProfileStateBackupJob,
  options: { workerPath?: string; timeoutMs?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = options.workerPath ?? resolveProfileStateBackupWorkerPath()
    const worker = new Worker(workerPath, { workerData: job, execArgv: [] })
    let completed = false
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error('Profile state backup worker timed out')
      void worker.terminate().catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
      })
    }, options.timeoutMs ?? BACKUP_TIMEOUT_MS)
    worker.on('message', (response: unknown) => {
      if (!isRecord(response) || typeof response.ok !== 'boolean') {
        failure = new Error('Invalid profile state backup worker response')
      } else if (!response.ok) {
        failure = new Error(String(response.error))
      } else {
        completed = true
      }
    })
    worker.on('error', (error) => {
      failure = error instanceof Error ? error : new Error(String(error))
    })
    // Even an error response leaves handles open until the worker actually exits.
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0 || !completed) {
        reject(
          failure ?? new Error(`Profile state backup worker exited without completion (${code})`)
        )
      } else {
        resolve()
      }
    })
  })
}
