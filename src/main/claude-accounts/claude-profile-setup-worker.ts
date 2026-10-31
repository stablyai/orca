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

// A terminated worker can stay inside an uninterruptible native call; never overlap one account's workers.
const accountWorkerExits = new Map<string, Promise<void>>()

/** Keep large history merges and synchronous filesystem calls off main. */
export function runClaudeProfileSetupInWorker(
  job: ClaudeProfileSetupJob,
  path = workerPath(),
  timeoutMs = 60_000
): Promise<ClaudeProfileSetupReport> {
  const accountId = job.profile.accountId
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let timedOut = false
    // Bound the wait for launches blocked on this setup, including an earlier worker's exit.
    const timer = setTimeout(() => {
      timedOut = true
      reject(new Error('Claude account setup timed out'))
      void worker?.terminate()
    }, timeoutMs)
    const previous = accountWorkerExits.get(accountId) ?? Promise.resolve()
    const exited = previous.then(
      () =>
        new Promise<void>((settle) => {
          if (timedOut) {
            settle()
            return
          }
          let failure: Error | undefined
          let result:
            | { ok: true; report: ClaudeProfileSetupReport }
            | { ok: false; error: string }
            | null = null
          let started: Worker
          try {
            started = new Worker(path, { workerData: job })
          } catch (error) {
            clearTimeout(timer)
            settle()
            reject(error instanceof Error ? error : new Error(String(error)))
            return
          }
          worker = started
          started.once('message', (message) => {
            result = message
          })
          started.once('error', (error) => {
            failure = error
          })
          started.once('exit', (code) => {
            clearTimeout(timer)
            settle()
            if (failure) {
              reject(failure)
            } else if (result?.ok) {
              resolve(result.report)
            } else {
              reject(new Error(result?.error ?? `Claude account setup worker exited (${code})`))
            }
          })
        })
    )
    accountWorkerExits.set(accountId, exited)
    void exited.then(() => {
      if (accountWorkerExits.get(accountId) === exited) {
        accountWorkerExits.delete(accountId)
      }
    })
  })
}
