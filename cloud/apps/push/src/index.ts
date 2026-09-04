import { loadPushConfig } from './config.js'
import { openPushDatabase } from './push-database.js'
import { createPushServer } from './push-server.js'

const CHALLENGE_PRUNE_INTERVAL_MS = 60_000
const SESSION_PRUNE_INTERVAL_MS = 10 * 60_000
const SEND_LOG_PRUNE_INTERVAL_MS = 30 * 60_000

const config = loadPushConfig()
const database = await openPushDatabase({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  dataDir: config.dataDir,
  poolMax: config.databasePoolMax,
  applicationName: 'orca-push'
})
const { server, challenges, sessions, quota, coalescer, observability, closeTransports } =
  createPushServer(config, database)

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

const timers = [
  prune('challenges', () => challenges.pruneExpired(), CHALLENGE_PRUNE_INTERVAL_MS),
  prune('sessions', () => sessions.pruneExpired(), SESSION_PRUNE_INTERVAL_MS),
  prune('send_log', () => quota.prune(), SEND_LOG_PRUNE_INTERVAL_MS)
]
observability.start()

server.listen(config.port, () => {
  console.log(`[orca-push] listening on ${config.publicUrl} (port ${config.port})`)
})

const shutdown = (): void => {
  for (const timer of timers) clearInterval(timer)
  observability.stop()
  // Drain the coalescing windows so an in-flight burst still reaches the phone.
  void coalescer.flushAll().finally(() => {
    coalescer.stop()
    closeTransports()
    server.close(() => void database.close())
  })
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
