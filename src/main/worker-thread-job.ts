import { Worker } from 'node:worker_threads'

/** What a job's entry posts back before it closes its port. */
export type WorkerThreadJobReply<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Run one job on a worker thread of its own and settle with what its entry posts.
 * `env` replaces the thread's environment without touching this process's.
 */
export function runWorkerThreadJob<T>(args: {
  path: string
  workerData: unknown
  /** Names the job in the timeout and exit errors. */
  label: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(args.path, {
      workerData: args.workerData,
      ...(args.env ? { env: args.env } : {})
    })
    // Why: a hung job would hold whoever awaits it, and everything queued behind them, forever.
    const timer = setTimeout(() => {
      reject(new Error(`${args.label} timed out`))
      void worker.terminate()
    }, args.timeoutMs)
    let reply: WorkerThreadJobReply<T> | null = null
    worker.once('message', (message: WorkerThreadJobReply<T>) => {
      reply = message
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (reply?.ok) {
        resolve(reply.value)
      } else {
        reject(new Error(reply?.error ?? `${args.label} worker exited (${code})`))
      }
    })
  })
}
