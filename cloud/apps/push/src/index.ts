import { startPushBackground } from './push-background.js'
import { loadPushConfig } from './config.js'
import { openPushDatabase } from './database/push-database.js'
import { createPushServer } from './push-server.js'
import { resolvePublicUrlProxyAddresses } from './http/public-url-proxy-addresses.js'
import { clientIpPolicy, describeClientIpPolicy } from './http/client-ip-rate-limit.js'

const loadedConfig = loadPushConfig()
const [database, publicUrlProxyAddresses] = await Promise.all([
  openPushDatabase({
    ...(loadedConfig.databaseUrl === undefined ? {} : { databaseUrl: loadedConfig.databaseUrl }),
    dataDir: loadedConfig.dataDir,
    poolMax: loadedConfig.databasePoolMax,
    applicationName: 'orca-push',
    readOnly: loadedConfig.mode === 'validation'
  }),
  resolvePublicUrlProxyAddresses(loadedConfig.publicUrl, {
    // Configured hops or addresses already find the client without discovery.
    required: loadedConfig.trustedProxyHops === 0 && loadedConfig.trustedProxyAddresses.length === 0
  })
])
const config = {
  ...loadedConfig,
  trustedProxyAddresses: [
    ...new Set([...loadedConfig.trustedProxyAddresses, ...publicUrlProxyAddresses])
  ]
}
console.log(
  JSON.stringify({
    event: 'orca_push_client_ip_policy',
    ...describeClientIpPolicy(clientIpPolicy(config))
  })
)
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
