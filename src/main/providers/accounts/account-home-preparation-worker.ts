import { access } from 'node:fs/promises'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'

export type AccountHomePreparationJob =
  | { kind: 'codex-config'; homePath: string; systemHomePath: string }
  | {
      kind: 'claude-import'
      sourceHome: string
      destination: string
      defaultHome: string
      importHistory: boolean
    }

export async function prepareAccountHomeInWorker(job: AccountHomePreparationJob): Promise<void> {
  const compiled = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'account-home-preparation-worker-entry.js'
  )
  const entry = await access(compiled).then(
    () => compiled,
    () => new URL('./account-home-preparation-worker-entry.ts', import.meta.url)
  )
  const worker = spawnWorkerThread(entry, {
    name: 'orca-account-home-preparation',
    workerData: job
  })
  await new Promise<void>((resolve, reject) => {
    let result: { ok: true } | { ok: false; error: string } | undefined
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error('Account home preparation timed out. Try again.')
      void worker.terminate().catch(reject)
    }, 120_000)
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
      } else if (result?.ok && code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            result && !result.ok ? result.error : `Account home preparation worker exited (${code})`
          )
        )
      }
    })
  })
}
