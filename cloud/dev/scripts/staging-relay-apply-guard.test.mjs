import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertStagingRelayAwake,
  stagingRelayPowerState
} from './staging-relay-apply-guard.mjs'

function gcloud(policy, targetSizes) {
  return (args) =>
    args[0] === 'sql'
      ? policy
      : JSON.stringify(
          targetSizes.map((targetSize, index) => ({
            name: `orca-cloud-staging-relay-gce-c${index + 1}`,
            targetSize
          }))
        )
}

test('reads and accepts a fully awake staging topology', () => {
  const command = gcloud('ALWAYS', [1, 1, 1])
  assert.equal(stagingRelayPowerState(command).groups.length, 3)
  assert.doesNotThrow(() => assertStagingRelayAwake(command))
})

test('refuses Terraform apply while SQL or any staging cell is asleep', () => {
  assert.throws(() => assertStagingRelayAwake(gcloud('NEVER', [0, 0, 0])), /wake workflow/)
  assert.throws(() => assertStagingRelayAwake(gcloud('ALWAYS', [1, 0, 0])), /partially awake/)
  assert.throws(() => assertStagingRelayAwake(gcloud('ALWAYS', [])), /partially awake/)
})
