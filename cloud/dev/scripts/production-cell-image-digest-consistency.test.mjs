import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PRODUCTION_CAPACITY_CELL_IDS } from './prepare-relay-production-capacity-canary.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const production = source('infra/terraform/environments/production.tfvars')
const dispatchWorkflow = readRelayWorkflow('deploy-relay-production-capacity.yml')
const jobWorkflow = readRelayWorkflow('deploy-relay-production-capacity-job.yml')

const RELAY_REPOSITORY = 'us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay'

function source(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

// Slice each "<cell-id>" = { ... } entry out of relay_gce_cells.
function productionCells() {
  const block = production.slice(production.indexOf('relay_gce_cells = {'))
  const cells = new Map()
  for (const match of block.matchAll(/"(production-gce-c\d+)" = \{([\s\S]*?)\n {2}\}/g)) {
    cells.set(match[1], match[2])
  }
  assert.ok(cells.size > 0, 'relay_gce_cells parsed empty')
  return cells
}

function hardCap(body) {
  const match = body.match(/connection_hard_cap\s*=\s*(\d+)/)
  return match ? Number(match[1]) : undefined
}

function imageDigest(body) {
  const match = body.match(/^\s*image\s*=\s*"([^"]+)"/m)
  assert.ok(match, 'cell entry has no image')
  const [repository, digest] = match[1].split('@')
  assert.equal(repository, RELAY_REPOSITORY)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  return digest
}

function workflowPin(workflow, name) {
  const match = workflow.match(new RegExp(`${name}: (sha256:[0-9a-f]{64})`))
  assert.ok(match, `${name} is missing or not a full digest`)
  return match[1]
}

test('every production cell pins a full relay image digest', () => {
  for (const [cellId, body] of productionCells()) {
    assert.match(imageDigest(body), /^sha256:[0-9a-f]{64}$/, `${cellId} image digest`)
  }
})

test('the 1,000-cap cells are exactly the canonical capacity set', () => {
  const thousandCap = [...productionCells()]
    .filter(([, body]) => hardCap(body) === 1000)
    .map(([cellId]) => cellId)
  assert.deepEqual([...thousandCap].sort(), [...PRODUCTION_CAPACITY_CELL_IDS].sort())
})

test('the 1,000-cap cells all serve one image digest', () => {
  const digests = new Map()
  for (const [cellId, body] of productionCells()) {
    if (hardCap(body) !== 1000) continue
    const digest = imageDigest(body)
    if (!digests.has(digest)) digests.set(digest, [])
    digests.get(digest).push(cellId)
  }
  assert.equal(
    digests.size,
    1,
    `1,000-cap cells split across digests: ${JSON.stringify([...digests])}`
  )
  assert.equal([...digests.values()][0].length, PRODUCTION_CAPACITY_CELL_IDS.length)
})

// COMPATIBLE_CELL_IMAGE_DIGEST is one half of a reviewed (director, cell) skew pair, not a
// claim about what the fleet serves; it is re-derived by hand for each capacity wave. So it
// is deliberately NOT tied to the tfvars digest — only to its twin in the dispatch workflow.
test('both capacity workflows declare the same reviewed image pins', () => {
  for (const name of ['PREDECESSOR_IMAGE_DIGEST', 'COMPATIBLE_CELL_IMAGE_DIGEST']) {
    assert.equal(workflowPin(dispatchWorkflow, name), workflowPin(jobWorkflow, name), name)
  }
  workflowPin(jobWorkflow, 'COMPATIBLE_DIRECTOR_IMAGE_DIGEST')
})
