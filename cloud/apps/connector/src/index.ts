import { openCloudNotifications } from '@orca-cloud/cloud-database'
import { loadConnectorConfig } from './config.js'
import { startConnectorBackground } from './connector-background.js'
import { openConnectorDatabase } from './connector-database.js'
import { createConnectorServer, listenHostname } from './connector-server.js'
import { runDiscordGatewayWorker } from './discord-gateway-worker.js'

const config = loadConnectorConfig()
const database = await openConnectorDatabase({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  dataDir: config.dataDir,
  poolMax: config.databasePoolMax,
  applicationName: 'orca-connector',
  readOnly: config.mode === 'validation'
})
const notifications = openCloudNotifications({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  applicationName: 'orca-connector'
})

async function serveApi(): Promise<void> {
  const runtime = createConnectorServer(config, database, notifications)
  const active = config.mode === 'active'
  if (active) {
    await runtime.waker.start()
  }
  const stopBackground = active ? startConnectorBackground(runtime) : () => {}

  runtime.server.listen(config.port, listenHostname(config.publicUrl), () => {
    console.log(`[orca-connector] listening on ${config.publicUrl} (port ${config.port})`)
  })

  let stopping = false
  const shutdown = (): void => {
    if (stopping) {
      return
    }
    stopping = true
    // Cloud Run sends SIGKILL after ten seconds; leave time for explicit cleanup.
    const deadline = setTimeout(() => process.exit(1), 9_000)
    deadline.unref()
    stopBackground()
    // Held polls answer at once with a reconnect, so the drain is not held up by them.
    runtime.waker.drain()
    const requests = runtime.requestDrain.begin()
    const connections = new Promise<void>((resolve) => runtime.server.close(() => resolve()))
    void Promise.all([requests, connections])
      .then(async () => {
        await runtime.waker.close()
        await database.close()
        clearTimeout(deadline)
      })
      .catch(() => {
        console.warn(JSON.stringify({ event: 'orca_connector_shutdown_failed' }))
        process.exitCode = 1
      })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

async function runDiscordGateway(): Promise<void> {
  const stop = new AbortController()
  process.once('SIGTERM', () => stop.abort())
  process.once('SIGINT', () => stop.abort())
  // Cloud Run sends SIGKILL ten seconds after SIGTERM; a stop of any cause gets the same bound.
  const bound = () => setTimeout(() => process.exit(1), 9_000).unref()
  const exitCode = await runDiscordGatewayWorker({
    config,
    database,
    notifications,
    signal: stop.signal,
    onStopping: bound
  })
  bound()
  await database.close()
  process.exit(exitCode)
}

await (config.role === 'discord-gateway' ? runDiscordGateway() : serveApi())
