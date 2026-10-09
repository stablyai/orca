import type { PushConfig } from './config.js'
import type { PushPruneSweep } from './durable-push-store.js'
import type { createPushServer } from './push-server.js'

const CHALLENGE_PRUNE_INTERVAL_MS = 60_000
const SESSION_PRUNE_INTERVAL_MS = 10 * 60_000
const DELIVERY_PRUNE_INTERVAL_MS = 60_000

// Chained rather than periodic, so a sweep spanning many bounded statements never overlaps itself and
// one that exhausted its batch budget resumes at once instead of idling out the rest of the interval.
function prune(label: string, run: () => Promise<PushPruneSweep>, intervalMs: number): () => void {
  let timer: NodeJS.Timeout | undefined
  let overdue: NodeJS.Timeout | undefined
  let stopped = false
  function schedule(delayMs: number): void {
    if (stopped) return
    timer = setTimeout(tick, delayMs)
    timer.unref()
  }
  function tick(): void {
    // Admission waits are untimed, so a lost slot release would otherwise stall retention silently.
    overdue = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'orca_push_prune_overdue', target: label }))
    }, intervalMs)
    overdue.unref()
    void run()
      .then((sweep) => schedule(sweep.saturated ? 0 : intervalMs))
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'orca_push_prune_failed',
            target: label,
            error: error instanceof Error ? error.name : 'unknown'
          })
        )
        schedule(intervalMs)
      })
      .finally(() => clearTimeout(overdue))
  }
  schedule(intervalMs)
  return () => {
    stopped = true
    clearTimeout(timer)
    clearTimeout(overdue)
  }
}

// One DELETE under a statement timeout: there is no batch budget for it to exhaust.
const unbatchedSweep =
  (run: () => Promise<number>) =>
  async (): Promise<PushPruneSweep> => ({ deleted: await run(), saturated: false })

export function startPushBackground(
  config: Pick<PushConfig, 'mode'>,
  runtime: Pick<
    ReturnType<typeof createPushServer>,
    'challenges' | 'sessions' | 'deliveryStore' | 'worker'
  >
): () => Promise<void> {
  if (config.mode === 'validation') return async () => {}
  const { challenges, sessions, deliveryStore, worker } = runtime
  const stops = [
    prune(
      'challenges',
      unbatchedSweep(() => challenges.pruneExpired()),
      CHALLENGE_PRUNE_INTERVAL_MS
    ),
    prune(
      'sessions',
      unbatchedSweep(() => sessions.pruneExpired()),
      SESSION_PRUNE_INTERVAL_MS
    ),
    prune('deliveries', () => deliveryStore.prune(), DELIVERY_PRUNE_INTERVAL_MS)
  ]
  worker.start()
  return async () => {
    for (const stop of stops) stop()
    await worker.stop()
  }
}
