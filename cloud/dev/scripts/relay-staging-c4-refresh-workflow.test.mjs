import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const githubActions = readFileSync(
  new URL('../../infra/terraform/relay-github-actions.tf', import.meta.url),
  'utf8'
)
const cells = readFileSync(
  new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
  'utf8'
)
const relay = readFileSync(new URL('../../infra/terraform/relay.tf', import.meta.url), 'utf8')
const stagingTfvars = readFileSync(
  new URL('../../infra/terraform/environments/staging.tfvars', import.meta.url),
  'utf8'
)
const productionTfvars = readFileSync(
  new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
  'utf8'
)

const launchDigest = '5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563'

// Scoped to the Asia cells by name: the production capacity cells now serve this digest too,
// so a file-wide count no longer isolates Asia.
const asiaCells = ['production-gce-c27', 'production-gce-c28', 'production-gce-c29']

function cellBlock(tfvars, cellId) {
  const start = tfvars.indexOf(`"${cellId}"`)
  assert.notEqual(start, -1, `${cellId} is missing`)
  return tfvars.slice(start, tfvars.indexOf('\n  }', start))
}

const productionCell = (cellId) => cellBlock(productionTfvars, cellId)

// Scoped to C4 by name: staging C3 serves this digest too since its 2026-09-03 re-pin.
test('pins staging C4 and all production Asia cells to the same launch image', () => {
  assert.match(cellBlock(stagingTfvars, 'staging-gce-c4'), new RegExp(`relay@sha256:${launchDigest}"`))
  for (const cellId of asiaCells) {
    assert.match(productionCell(cellId), new RegExp(`relay@sha256:${launchDigest}"`), cellId)
  }
})

// The recovery workflow runs from the public repo now, but this root still allowlists its file
// name in the capacity provider, once per accepted repository.
test('the capacity identity still admits the C4 recovery workflow file', () => {
  assert.match(githubActions, /"recover-relay-staging-c4-image\.yml"/)
})

test('keeps cell-only plans independent from service-account description drift', () => {
  assert.match(cells, /runtime_service_account\s+= local\.relay_runtime_service_account_email/)
  assert.match(
    cells,
    /rehome_director_service_account\s+= local\.relay_director_runtime_service_account_email/
  )
  assert.match(relay, /var\.environment == "staging" \? "Orca Relay"/)
})
