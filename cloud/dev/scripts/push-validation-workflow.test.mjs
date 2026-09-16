import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'

const workflow = readRelayWorkflow('push-deploy.yml')
const position = (name) => {
  const index = workflow.indexOf(`- name: ${name}`)
  assert.notEqual(index, -1)
  return index
}
const capability = position('Require image support for inert validation')
const deploy = position('Deploy the candidate revision with no traffic')
const activation = position('Retire inert validation and activate the verified image')
const shift = position('Shift all traffic to the verified candidate')

test('the exact build digest must support validation before production boot', () => {
  assert.match(workflow, /docker buildx build --push --platform linux\/amd64 --provenance=false --metadata-file/)
  assert.match(workflow, /containerimage\.digest/)
  assert.doesNotMatch(workflow, /gcloud artifacts docker images describe/)
  assert.ok(capability < deploy)
  const preflight = workflow.slice(capability, deploy)
  assert.match(preflight, /docker run --rm --network none --entrypoint node "\$\{IMAGE\}"/)
  assert.match(preflight, /loadPushConfig\(env\)\.mode !== "validation"/)
  assert.match(preflight, /validation_mode_not_fail_closed/)
})

test('inert validation and credential checks precede deliberate activation of the same digest', () => {
  assert.match(workflow.slice(deploy, activation), /--update-env-vars ORCA_PUSH_MODE=validation/)
  assert.match(workflow.slice(deploy, activation), /\.mode == "validation"/)
  assert.ok(position('Prove the runtime identity can reach FCM') < activation)
  const active = workflow.slice(activation, shift)
  assert.ok(active.indexOf('gcloud run deploy') < active.indexOf('gcloud run revisions delete'))
  assert.match(active, /--image "\$\{IMAGE\}"/)
  assert.match(active, /--remove-env-vars ORCA_PUSH_MODE/)
  assert.match(active, /\.spec\.containers\[0\]\.image == \$image/)
  assert.match(active, /\.spec\.serviceAccountName == \$account/)
  assert.match(active, /\.mode == "active"/)
  assert.ok(active.indexOf('ACTIVATION_ATTEMPTED=true') < active.indexOf('gcloud run deploy'))
  assert.match(workflow, /deletion below must stop its workers/)
})

test('production startup connects read-only and gates all background work in validation', () => {
  const entry = readFileSync(new URL('../../apps/push/src/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /readOnly: config\.mode === 'validation'/)
  assert.match(entry, /startPushBackground\(config,/)
  assert.doesNotMatch(entry, /worker\.start\(/)
})
