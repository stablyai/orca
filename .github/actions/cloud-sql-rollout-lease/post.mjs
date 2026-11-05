import { readFileSync } from 'node:fs'
import { createAccessTokenSource } from './gcloud-access-token.mjs'
import { notice, renewerLogPath, savedState, warn } from './runner-state.mjs'
import { CloudSqlRolloutLease, describeHolder } from './storage-lease.mjs'

stopRenewer()
printRenewerLog()

if (savedState('acquired') !== 'true') {
  notice('No Cloud SQL rollout lease was acquired by this step; nothing to release.')
  process.exit(0)
}

const bucket = savedState('bucket')
const objectName = savedState('object')
const holderKey = savedState('holder_key')

if (savedState('release') !== 'true') {
  notice(
    `Holding gs://${bucket}/${objectName} for the rest of run ${holderKey}; a later job with release=true must free it.`
  )
  process.exit(0)
}

const lease = new CloudSqlRolloutLease({
  bucket,
  objectName,
  accessToken: createAccessTokenSource()
})

try {
  const result = await lease.release(holderKey)
  if (result.released) {
    notice(`Released ${lease.uri} at generation ${result.generation}.`)
  } else if (result.reason === 'absent') {
    notice(`${lease.uri} was already gone; nothing to release.`)
  } else if (result.reason === 'foreign') {
    warn(
      `${lease.uri} is now held by ${describeHolder(result.holder)}; leaving it alone. Our lease had already expired.`
    )
  } else {
    warn(`${lease.uri} changed while releasing it; leaving it to expire on its TTL.`)
  }
} catch (error) {
  // Never fail a job in post over a release; the TTL bounds the damage to 35 minutes.
  warn(`could not release ${lease.uri}: ${error.message}. It will expire on its TTL.`)
}

function stopRenewer() {
  const pid = Number(savedState('renewer_pid'))
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
    notice(`Stopped the lease renewer (pid ${pid}).`)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      warn(`could not stop the lease renewer ${pid}: ${error.message}`)
    }
  }
}

function printRenewerLog() {
  const path = renewerLogPath()
  if (!path) {
    return
  }
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  if (!text.trim()) {
    return
  }
  console.log('::group::Cloud SQL rollout lease renewer log')
  console.log(text.trimEnd())
  console.log('::endgroup::')
}
