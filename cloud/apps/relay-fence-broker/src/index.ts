import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp(config)

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[relay-fence-broker] listening on port ${info.port}`)
})
