import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the region-skew alert compares asia-east2's share of assignment hints against its share of
// actual placements. Both shares are sums over one log-based metric per region, and the region
// list is written out by hand in Terraform. A region added to the contract without matching
// metrics would silently drop out of both denominators and move the ratio the alert fires on.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const collapse = (text) => text.replaceAll(/\s+/g, ' ')

const contractRegions = (() => {
  const source = read('../../packages/relay-contract/src/relay-regions.ts')
  const literal = /export const RELAY_REGIONS = \[([^\]]*)\]/.exec(source)
  assert.ok(literal, 'RELAY_REGIONS literal not found in relay-regions.ts')
  return [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
})()

const terraform = read('../../infra/terraform/relay-observability.tf')

const terraformRegions = (() => {
  const literal = /relay_region_keys = \[([^\]]*)\]/.exec(terraform)
  assert.ok(literal, 'relay_region_keys not found in relay-observability.tf')
  return [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
})()

// Both sides now spell the field-name segments out, so the test compares the two declared maps
// rather than two source expressions. Reformatting either file cannot break this, and a literal
// expected value below still catches an identical wrong edit made to both.
const declaredSegments = (source, open, close) => {
  const body = source.slice(source.indexOf(open) + open.length, source.indexOf(close, source.indexOf(open)))
  return Object.fromEntries(
    [...body.matchAll(/'?"?([a-z0-9-]+)'?"?\s*[:=]\s*'?"?([A-Za-z0-9]+)'?"?/g)].map((match) => [
      match[1],
      match[2]
    ])
  )
}

const terraformSegments = declaredSegments(terraform, 'relay_region_field_segments = {', '}')
const contractSegments = declaredSegments(
  read('../../packages/relay-contract/src/relay-regions.ts'),
  'RELAY_REGION_METRIC_SEGMENTS = {',
  '}'
)

test('terraform covers exactly the regions the contract can hint or select', () => {
  assert.deepEqual([...terraformRegions].sort(), [...contractRegions].sort())
})

test('terraform and the contract declare the same flat field segments', () => {
  assert.deepEqual(terraformSegments, contractSegments)
  // Pinned literally so the same wrong edit applied to both sides still fails.
  assert.deepEqual(terraformSegments, { 'us-central1': 'UsCentral1', 'asia-east2': 'AsiaEast2' })
  assert.deepEqual(Object.keys(terraformSegments).sort(), [...contractRegions].sort())
})

test('the skew query compares a catalogued region against itself', () => {
  const columns = terraformRegions.map((region) => region.replaceAll('-', '_'))
  const hint = /hint_share: req_([a-z0-9_]+) \//.exec(terraform)
  const placement = /placement_share: sel_([a-z0-9_]+) \//.exec(terraform)
  assert.ok(hint && placement, 'skew query share columns not found')
  assert.equal(hint[1], placement[1], 'the two shares must be about the same region')
  assert.ok(columns.includes(hint[1]), `${hint[1]} is not one of ${columns.join(', ')}`)
})

test('the skew condition never divides by the placement share', () => {
  // A zero-placement hour is the worst skew there is; MQL drops the row on x/0, so the ratio form
  // silences exactly the case the alert exists for.
  assert.ok(
    !/hint_share \/ placement_share/.test(terraform),
    'cross-multiply instead: hint_share > 2 * placement_share'
  )
  assert.match(collapse(terraform), /condition hint_share > 2 \* placement_share/)
})

test('the unhinted bucket stays out of the skew denominators', () => {
  assert.ok(
    !terraformRegions.includes('unhinted'),
    'unhinted requests are a client-side choice, not a region; including them moves the share'
  )
})
