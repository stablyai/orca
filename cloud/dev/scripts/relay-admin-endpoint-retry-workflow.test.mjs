import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { relayWorkflowUrl } from './relay-repository.mjs'

const WORKFLOWS = [
  'deploy-relay-production-same-cap-job.yml',
  'operate-relay-production-rehome-job.yml'
]

function workflow(name) {
  return readFileSync(fileURLToPath(relayWorkflowUrl(name)), 'utf8')
}

// A single transient 5xx from a warming instance behind the global load balancer
// must not fail a canary, so no admin endpoint may be read by a bare curl.
test('no admin endpoint is reached by a curl without a bounded retry', () => {
  for (const name of WORKFLOWS) {
    for (const invocation of workflow(name).split(/\bcurl\b/).slice(1)) {
      const flags = invocation.split('\n          }')[0]
      assert.match(flags, /--retry 3 --retry-delay 2 --retry-connrefused/, name)
      assert.match(flags, /--max-time 30/, name)
      // --retry-all-errors would also retry 401, 403, and 409, which are final.
      assert.doesNotMatch(flags, /--retry-all-errors/, name)
    }
  }
})

test('every retried admin request captures only the final attempt body', () => {
  const job = workflow('deploy-relay-production-same-cap-job.yml')
  // --fail-with-body writes every failed attempt to stdout, so a retried
  // request must land in a file curl truncates per attempt.
  assert.match(job, /--output "\$\{out\}"/)
  assert.equal(job.split('admin_post() {').length - 1, 2)
  for (const call of [
    /CURRENT_RUNTIME="\$\(admin_post current-runtime/,
    /CURRENT_DIRECTOR_STATUS="\$\(admin_post current-cell-status/,
    /TARGET_RUNTIME="\$\(admin_post target-runtime/,
    /TARGET_DIRECTOR_STATUS="\$\(admin_post target-cell-status/
  ]) assert.match(job, call)
  assert.doesNotMatch(job, /\$\(curl /)
})
