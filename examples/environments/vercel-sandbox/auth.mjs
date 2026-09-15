import { loadConfig, credentials } from './configuration.mjs'

const config = loadConfig()
await credentials(config)
console.log('Vercel project authentication succeeded.')
console.log(
  process.env.AI_GATEWAY_API_KEY
    ? 'AI Gateway key is available for injection on each server start. Verify an actual agent turn after provisioning.'
    : 'No AI Gateway key found. Authenticate your coding agent inside each workspace using its documented login flow.'
)
