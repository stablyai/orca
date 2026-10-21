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

/** One worker per setup: a first setup can merge a large history tree with sync fs calls. */
export function runClaudeProfileSetupInWorker(
  job: ClaudeProfileSetupJob,
  path = workerPath(),
  timeoutMs = 60_000
): Promise<ClaudeProfileSetupReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path, { workerData: job })
    // Why: a hung setup would hold the router's in-flight entry, and every launch waiting on it, forever.
    const timer = setTimeout(() => {
      reject(new Error('Claude account setup timed out'))
      void worker.terminate()
    }, timeoutMs)
    let result:
      | { ok: true; report: ClaudeProfileSetupReport }
      | { ok: false; error: string }
      | null = null
    worker.once('message', (message) => {
      result = message
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (result?.ok) {
        resolve(result.report)
      } else {
        reject(new Error(result?.error ?? `Claude account setup worker exited (${code})`))
      }
    })
  })
}
