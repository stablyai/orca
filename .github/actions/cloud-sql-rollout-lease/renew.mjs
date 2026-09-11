import { appendFileSync } from 'node:fs'
import { createAccessTokenSource } from './gcloud-access-token.mjs'
import { renewerLogPath } from './runner-state.mjs'
import { CloudSqlRolloutLease, RENEW_INTERVAL_MS } from './storage-lease.mjs'

// Detached renewer. `main` spawns it, `post` kills it. It rewrites expires_at on the same
// generation-matched path as acquisition, and stops the moment the object stops being ours.

const MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000 // Backstop if post never runs (runner killed).

const [bucket, objectName, holderKey] = process.argv.slice(2)
const logPath = renewerLogPath()
const startedAt = Date.now()

function log(message) {
  if (!logPath) {
    return
  }
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // A renewer that cannot log must still renew.
  }
}

if (!bucket || !objectName || !holderKey) {
  log('renewer started without bucket/object/holder-key; exiting')
  process.exit(1)
}

const lease = new CloudSqlRolloutLease({
  bucket,
  objectName,
  accessToken: createAccessTokenSource(),
  warn: (message) => log(`warning ${message}`)
})

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true
    log(`received ${signal}; stopping`)
    process.exit(0)
  })
}

log(`renewer started for ${lease.uri} holder=${holderKey} interval=${RENEW_INTERVAL_MS}ms`)

while (!stopping) {
  await new Promise((resolve) => {
    setTimeout(resolve, RENEW_INTERVAL_MS)
  })
  if (stopping) {
    break
  }
  if (Date.now() - startedAt > MAX_LIFETIME_MS) {
    log('renewer hit its maximum lifetime; stopping so the lease can expire')
    break
  }
  try {
    const result = await lease.renew(holderKey)
    if (!result.renewed) {
      log(`lease is no longer ours (${result.reason}); stopping`)
      break
    }
    log(
      `renewed until ${new Date(result.record.expires_at).toISOString()} at generation ${result.generation}`
    )
  } catch (error) {
    // Transient GCS or token failures are retried on the next tick; the TTL covers 7 misses.
    log(`renewal attempt failed: ${error.message}`)
  }
}
