import { serve } from '@hono/node-server'
import { readConfig } from './config.js'
import { createSigningApis } from './github-app.js'
import { SigningGates } from './signing-gates.js'
import { createApp } from './app.js'
const config = readConfig()
const server = serve({
  fetch: createApp(config, new SigningGates(config, createSigningApis(config))).fetch,
  port: Number(process.env.PORT ?? 8080)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
