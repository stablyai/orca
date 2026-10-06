import { startPushBackground } from './push-background.js'
import { loadPushConfig } from './config.js'
import { openPushDatabase } from './push-database.js'
import { createPushServer } from './push-server.js'

const config = loadPushConfig()
const database = await openPushDatabase({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  dataDir: config.dataDir,
  poolMax: config.databasePoolMax,
  applicationName: 'orca-push',
  readOnly: config.mode === 'validation'
})
const {
  server,
  challenges,
  sessions,
  deliveryStore,
  worker,
  observability,
  closeTransports,
  requestDrain
} = createPushServer(config, database)

const stopBackground = startPushBackground(config, { challenges, sessions, deliveryStore, worker })
observability.start()

server.listen(config.port, () => {
  console.log(`[orca-push] listening on ${config.publicUrl} (port ${config.port})`)
})

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  // Cloud Run sends SIGKILL after ten seconds; leave time for explicit cleanup.
  const deadline = setTimeout(() => process.exit(1), 9_000)
  deadline.unref()
  const requests = requestDrain.begin()
  const deliveries = stopBackground()
  const connections = new Promise<void>((resolve) => server.close(() => resolve()))
  void Promise.all([requests, connections, deliveries])
    .then(async () => {
      closeTransports()
      await database.close()
      observability.stop()
      clearTimeout(deadline)
    })
    .catch(() => {
      console.warn(JSON.stringify({ event: 'orca_push_shutdown_failed' }))
      process.exitCode = 1
    })
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
