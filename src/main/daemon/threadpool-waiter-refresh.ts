import { constants, mkdtempSync, openSync, read, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export const THREADPOOL_WAITER_REFRESH_MS = 60_000
// Far longer than waking a parked worker; also the pool's only pause per round.
export const THREADPOOL_WAITER_HOLD_MS = 20

export type RefreshRound = (threads: number, done: () => void) => void

/** Mirrors libuv's init_threads(): atoi, 0 becomes 1, capped at 1024. */
export function libuvThreadpoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UV_THREADPOOL_SIZE
  if (raw === undefined) {
    return 4
  }
  const parsed = Number.parseInt(raw, 10)
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 0, 1), 1024)
}

/**
 * Each round posts one blocking FIFO read per worker and releases them together, so the reads
 * must occupy distinct workers: a worker holding one cannot take another.
 */
export async function createFifoHoldRound(): Promise<RefreshRound | null> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pool-refresh-'))
  const fifo = join(dir, 'hold')
  let fd: number
  try {
    const made = await runProcess({
      program: '/usr/bin/mkfifo',
      args: [fifo],
      timeoutMs: 3_000,
      maxOutputBytes: 4096
    })
    if (made.code !== 0) {
      return null
    }
    // O_RDWR never blocks the open, and the fd outlives the unlinked name.
    fd = openSync(fifo, constants.O_RDWR)
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return (threads, done) => {
    let left = threads
    for (let i = 0; i < threads; i++) {
      read(fd, Buffer.alloc(1), 0, 1, null, () => {
        left -= 1
        if (left === 0) {
          done()
        }
      })
    }
    setTimeout(() => {
      try {
        writeSync(fd, Buffer.alloc(threads))
      } catch {
        // Unreleased reads keep the round outstanding, which stops further rounds.
      }
    }, THREADPOOL_WAITER_HOLD_MS)
  }
}

/**
 * Darwin's psynch condvar stops waking a libuv worker that stayed parked through ~2^23 waits of
 * its siblings (libuv#5280): every later uv_cond_signal is a no-op, so fs work queues forever
 * while timers and sockets still run. Holding every worker once per interval wakes each parked
 * worker, which re-parks at the current generation long before it can fall half the range behind.
 */
export function startThreadpoolWaiterRefresh(
  options: {
    platform?: NodeJS.Platform
    threads?: number
    intervalMs?: number
    createRound?: () => Promise<RefreshRound | null>
  } = {}
): () => void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return () => {}
  }
  const threads = options.threads ?? libuvThreadpoolSize()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null
  void (options.createRound ?? createFifoHoldRound)().then((round) => {
    if (stopped || !round) {
      return
    }
    let outstanding = false
    timer = setInterval(() => {
      // A pool that has not finished the last round is already stuck or saturated; never pile on.
      if (outstanding) {
        return
      }
      outstanding = true
      round(threads, () => {
        outstanding = false
      })
    }, options.intervalMs ?? THREADPOOL_WAITER_REFRESH_MS)
    timer.unref()
  })
  return () => {
    stopped = true
    if (timer) {
      clearInterval(timer)
    }
  }
}
