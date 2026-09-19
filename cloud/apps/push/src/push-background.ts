import type { PushConfig } from './config.js'
import type { createPushServer } from './push-server.js'

const CHALLENGE_PRUNE_INTERVAL_MS = 60_000
const SESSION_PRUNE_INTERVAL_MS = 10 * 60_000
const DELIVERY_PRUNE_INTERVAL_MS = 60_000

function prune(label: string, run: () => Promise<number>, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    void run().catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'orca_push_prune_failed',
          target: label,
          error: error instanceof Error ? error.name : 'unknown'
        })
      )
    })
  }, intervalMs)
  timer.unref()
  return timer
}

export function startPushBackground(
  config: Pick<PushConfig, 'mode'>,
  runtime: Pick<
    ReturnType<typeof createPushServer>,
    'challenges' | 'sessions' | 'deliveryStore' | 'worker'
  >
): () => Promise<void> {
  if (config.mode === 'validation') return async () => {}
  const { challenges, sessions, deliveryStore, worker } = runtime
  const timers = [
    prune('challenges', () => challenges.pruneExpired(), CHALLENGE_PRUNE_INTERVAL_MS),
    prune('sessions', () => sessions.pruneExpired(), SESSION_PRUNE_INTERVAL_MS),
    prune('deliveries', () => deliveryStore.prune(), DELIVERY_PRUNE_INTERVAL_MS)
  ]
  worker.start()
  return async () => {
    for (const timer of timers) clearInterval(timer)
    await worker.stop()
  }
}
