import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAccessTokenSource } from './gcloud-access-token.mjs'
import { holderIdentity } from './holder-identity.mjs'
import { fail, input, notice, renewerLogPath, saveState, setOutput, warn } from './runner-state.mjs'
import { CloudSqlRolloutLease, LeaseConflict, describeHolder } from './storage-lease.mjs'

const bucket = input('bucket')
const objectName = input('object')
const release = input('release') !== 'false'

if (!bucket || !objectName) {
  fail('cloud-sql-rollout-lease requires both `bucket` and `object`')
  process.exit(1)
}

const holder = holderIdentity(input('holder-key'))
const lease = new CloudSqlRolloutLease({
  bucket,
  objectName,
  accessToken: createAccessTokenSource()
})

let claim
try {
  claim = await lease.acquire(holder)
} catch (error) {
  if (error instanceof LeaseConflict) {
    fail(
      `${error.message}. Cloud SQL rollouts are serialized across repositories; this run will not queue or steal the lease. Wait for the holder to finish, then re-run.`
    )
    if (error.holder) {
      console.log(`Lease holder repository: ${error.holder.repository}`)
      console.log(`Lease holder workflow:   ${error.holder.workflow}`)
      console.log(`Lease holder run:        ${error.holder.run_url}`)
    }
  } else {
    // Bucket unreachable, permission denied, unreadable record: fail closed.
    fail(`could not acquire ${lease.uri}: ${error.message}`)
  }
  process.exit(1)
}

// Persist before anything else can throw, so `post` always releases what we hold.
saveState('acquired', 'true')
saveState('bucket', bucket)
saveState('object', objectName)
saveState('holder_key', holder.holderKey)
saveState('release', release ? 'true' : 'false')

setOutput('holder-key', holder.holderKey)
setOutput('generation', claim.generation)
setOutput('expires-at', new Date(claim.record.expires_at).toISOString())
setOutput('reentrant', claim.state === 'reentrant' ? 'true' : 'false')

if (claim.state === 'reentrant') {
  notice(
    `Re-entered the Cloud SQL rollout lease on ${lease.uri} already held by this run; refreshed to ${new Date(claim.record.expires_at).toISOString()}.`
  )
} else if (claim.state === 'takeover') {
  notice(`Took over ${lease.uri} from ${describeHolder(claim.previous)}.`)
} else {
  notice(
    `Acquired ${lease.uri} until ${new Date(claim.record.expires_at).toISOString()} (holder ${holder.holderKey}).`
  )
}

try {
  const renewer = spawn(
    process.execPath,
    [fileURLToPath(new URL('./renew.mjs', import.meta.url)), bucket, objectName, holder.holderKey],
    { detached: true, stdio: 'ignore', env: process.env }
  )
  renewer.unref()
  saveState('renewer_pid', String(renewer.pid))
  const log = renewerLogPath()
  notice(`Lease renewer running as pid ${renewer.pid}${log ? `, logging to ${log}` : ''}.`)
} catch (error) {
  // A missing renewer is survivable for short jobs; the TTL still covers 35 minutes.
  warn(`could not start the lease renewer: ${error.message}. The lease will expire on its TTL.`)
}
