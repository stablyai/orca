import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseProductionCapacityCellArguments } from './prepare-relay-production-capacity-canary.mjs'
import { SAME_CAP_CELLS } from './relay-production-same-cap-wave.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'
import { validateCapacityPlan } from './validate-relay-capacity-plan.mjs'

const workflow = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
const capacityWorkflow = readRelayWorkflow('deploy-relay-production-capacity-job.yml')
const production = readFileSync(
  new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
  'utf8'
)
const REHOME_SOURCE_CELLS = rehomeSourceCells()
const DIRECTOR_IDENTITY = 'relay-director@onorca-cloud.iam.gserviceaccount.com'
const AUDIENCE = 'https://relay.onorca.dev/v1/admin/host-drain'
const ROLLBACK_IMAGE = `us-central1-docker.pkg.dev/p/orca-cloud/relay@sha256:${'d'.repeat(64)}`
const TARGET_IMAGE = `us-central1-docker.pkg.dev/p/orca-cloud/relay@sha256:${'e'.repeat(64)}`

// The startup template emits rehome trust only for cells in this list, so it is what decides
// whether a cell's plan may carry those lines at all.
function rehomeSourceCells() {
  const start = production.indexOf('relay_region_rehome_source_cell_ids = [')
  assert.notEqual(start, -1, 'production.tfvars has no rehome source cell list')
  const end = production.indexOf(']', start)
  assert.notEqual(end, -1, 'the rehome source cell list is unterminated')
  return new Set(
    [...production.slice(start, end).matchAll(/"([^"]+)"/g)].map(([, cell]) => cell)
  )
}

function startupScript({ cap, image, trusted }) {
  return [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(trusted ? [
      `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${DIRECTOR_IDENTITY}'`,
      `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${AUDIENCE}'`
    ] : []),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${image.split('@')[1]}'`,
    `docker pull '${image}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${image}'`
  ].join('\n')
}

// The exact shape the apply step's plan has: template replaced, MIG rebound to it.
function rollPlan({ cellId, cap, protocol }) {
  return {
    configuration: {
      root_module: {
        resources: [{
          address: 'google_compute_instance_group_manager.relay_gce_cell',
          expressions: {
            version: [{
              instance_template: {
                references: [
                  'google_compute_instance_template.relay_gce_cell',
                  'each.key'
                ]
              },
              name: { constant_value: 'primary' }
            }]
          }
        }]
      }
    },
    resource_changes: [
      {
        address: `google_compute_instance_template.relay_gce_cell[${JSON.stringify(cellId)}]`,
        change: {
          actions: ['create', 'delete'],
          before: {
            metadata_startup_script: startupScript({
              cap,
              image: ROLLBACK_IMAGE,
              trusted: protocol === 1
            })
          },
          after: {
            metadata_startup_script: startupScript({
              cap,
              image: TARGET_IMAGE,
              trusted: protocol === 1
            }),
            self_link: null
          },
          after_unknown: { self_link: true }
        }
      },
      {
        address: `google_compute_instance_group_manager.relay_gce_cell[${JSON.stringify(cellId)}]`,
        change: {
          actions: ['update'],
          before: { target_size: 1, version: [{ instance_template: 'old' }] },
          after: { target_size: 1, version: [{ instance_template: null }] },
          after_unknown: { version: [{ instance_template: true }] }
        }
      }
    ]
  }
}

function hostname(cellId) {
  return cellId.slice('production-gce-'.length)
}

// The job resolves cap and region from the cell id before any admin call; run that block alone.
function resolveCellShape(cellId) {
  const start = workflow.indexOf('          TARGET_HOSTNAME="${TARGET_CELL_ID#production-gce-}"')
  assert.notEqual(start, -1, 'the same-cap cell shape block is missing')
  const end = workflow.indexOf('\n          esac\n', start)
  assert.notEqual(end, -1, 'the same-cap cell shape block has no esac')
  const script = workflow.slice(start, end + '\n          esac'.length).replace(/^ {10}/gm, '')
  return spawnSync('bash', [
    '-euo',
    'pipefail',
    '-c',
    `${script}\necho "\${EXPECTED_REGION} \${EXPECTED_HARD_CAP}"`
  ], { env: { ...process.env, TARGET_CELL_ID: cellId }, encoding: 'utf8' })
}

describe('same-cap roll scripts accept every same-cap cell', () => {
  it('parses every wave cell through the same-cap canary allowlist', () => {
    for (const cellId of SAME_CAP_CELLS) {
      for (const mode of ['isolate', 'drain', 'activate']) {
        assert.deepEqual(parseProductionCapacityCellArguments([
          '--director-origin', 'https://relay.onorca.dev',
          '--cell-origin', `https://${hostname(cellId)}.relay.onorca.dev`,
          '--cell-id', cellId,
          '--approved-cells', 'same-cap',
          '--mode', mode
        ]), {
          directorOrigin: 'https://relay.onorca.dev',
          cellOrigin: `https://${hostname(cellId)}.relay.onorca.dev`,
          cellId,
          mode
        })
      }
    }
  })

  it('resolves a cap and region for every wave cell and refuses anything else', () => {
    for (const cellId of SAME_CAP_CELLS) {
      const resolved = resolveCellShape(cellId)
      assert.equal(resolved.status, 0, `${cellId}: ${resolved.stderr}`)
      assert.match(resolved.stdout.trim(), /^(us-central1 1000|asia-east2 3000)$/)
    }
    assert.equal(resolveCellShape('production-gce-c17').status, 1)
    assert.equal(resolveCellShape('production-gce-c30').status, 1)
  })

  it('passes the same-cap allowlist on every canary invocation the job runs', () => {
    const invocations = workflow.split('prepare-relay-production-capacity-canary.mjs').slice(1)
    assert.equal(invocations.length, 4)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.endsWith('\\'))
      const call = lines.slice(0, end + 1).join(' ')
      assert.match(call, /--approved-cells same-cap/)
      assert.match(call, /--mode (isolate|drain|activate)/)
    }
  })

  it('passes this cell\'s rehome protocol on every plan validation the job runs', () => {
    const invocations = workflow.split('validate-relay-capacity-plan.mjs').slice(1)
    assert.equal(invocations.length, 2)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'))
      const call = lines.slice(0, end + 1).join(' ')
      assert.match(call, /--mode same-cap-cell/)
      assert.match(call, /--regional-rehome-protocol "\$\{DESIRED_REHOME_PROTOCOL\}"/)
    }
  })

  it('validates a correct plan for every wave cell at that cell\'s rehome protocol', () => {
    for (const cellId of SAME_CAP_CELLS) {
      const [region, cap] = resolveCellShape(cellId).stdout.trim().split(' ')
      const protocol = REHOME_SOURCE_CELLS.has(cellId) ? 1 : 0
      assert.equal(protocol, region === 'us-central1' ? 1 : 0, cellId)
      const config = {
        mode: 'same-cap-cell',
        cellId,
        hardCap: Number(cap),
        unobservedBound: 60,
        image: TARGET_IMAGE,
        rollbackImage: ROLLBACK_IMAGE,
        rehomeDirectorServiceAccount: DIRECTOR_IDENTITY,
        rehomeAudience: AUDIENCE,
        regionalRehomeProtocol: String(protocol)
      }
      const plan = rollPlan({ cellId, cap, protocol })
      assert.deepEqual(
        validateCapacityPlan(plan, config),
        { mode: 'same-cap-cell', changes: 2 },
        cellId
      )
      // The other protocol must reject the same plan, or the flag decides nothing.
      assert.throws(
        () => validateCapacityPlan(plan, {
          ...config,
          regionalRehomeProtocol: String(1 - protocol)
        }),
        /reviewed image and capacity/,
        cellId
      )
    }
  })

  it('leaves the US-only capacity job on the default allowlist', () => {
    assert.doesNotMatch(capacityWorkflow, /--approved-cells/)
  })
})
