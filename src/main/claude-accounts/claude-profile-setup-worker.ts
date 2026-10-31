import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

export type ClaudeProfileSetupJob = {
  dataRoot: string
  profile: ClaudeProfileDescriptor
  userHome: string
  userConfigDir: string | undefined
  hooks: boolean
  claudeVersion: string | undefined
}

const WORKER_FILENAME = 'claude-profile-setup-worker-entry.js'

function workerPath(): string {
  const entry = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  // Rollup can place this launcher in a shared chunk beside the worker entries.
  return [entry, join(dirname(entry), '..', WORKER_FILENAME)].find(existsSync) ?? entry
}

/** Keep large history merges and synchronous filesystem calls off main. */
export function runClaudeProfileSetupInWorker(
  job: ClaudeProfileSetupJob,
  path = workerPath(),
  timeoutMs = 60_000
): Promise<ClaudeProfileSetupReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path, { workerData: job })
    let failure: Error | undefined
    // Bound the wait for launches blocked on this setup.
    const timer = setTimeout(() => {
      failure = new Error('Claude account setup timed out')
      void worker.terminate()
    }, timeoutMs)
    let result:
      | { ok: true; report: ClaudeProfileSetupReport }
      | { ok: false; error: string }
      | null = null
    worker.once('message', (message) => {
      result = message
    })
    worker.once('error', (error) => {
      failure = error
    })
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (failure) {
        reject(failure)
      } else if (result?.ok) {
        resolve(result.report)
      } else {
        reject(new Error(result?.error ?? `Claude account setup worker exited (${code})`))
      }
    })
  })
}
