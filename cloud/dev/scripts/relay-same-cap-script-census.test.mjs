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

// The job cross-checks its pinned pool against the committed map; model the same read.
function tfvarsDatabasePoolMax(cellId) {
  const start = production.indexOf(`"${cellId}" = {`)
  assert.notEqual(start, -1, `${cellId} is missing from production.tfvars`)
  const block = production.slice(start, production.indexOf('\n  }', start))
  return /database_pool_max\s*=\s*(\d+)/.exec(block)?.[1] ?? '10'
}

function startupScript({ cap, image, trusted, pool }) {
  return [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(pool === undefined
      ? []
      : [`  printf 'ORCA_RELAY_DATABASE_POOL_MAX=%s\\n' '${pool}'`]),
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
function rollPlan({ cellId, cap, protocol, pool }) {
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
              trusted: protocol >= 1,
              // The live template predates the reviewed pool raise, as every asia cell's does.
              pool: pool === undefined ? undefined : '10'
            })
          },
          after: {
            metadata_startup_script: startupScript({
              cap,
              image: TARGET_IMAGE,
              trusted: protocol >= 1,
              pool
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

// The job resolves cap, region, and pool from the cell id before any admin call; run that block
// alone. An empty pool is the root default, which the startup template emits no line for.
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
    `${script}\necho "\${EXPECTED_REGION} \${EXPECTED_HARD_CAP} pool=\${EXPECTED_DATABASE_POOL_MAX}"`
  ], { env: { ...process.env, TARGET_CELL_ID: cellId }, encoding: 'utf8' })
}

function cellShape(cellId) {
  const resolved = resolveCellShape(cellId)
  assert.equal(resolved.status, 0, `${cellId}: ${resolved.stderr}`)
  const [, cap, pool] = resolved.stdout.trim().split(' ')
  return { cap: Number(cap), pool: pool.slice('pool='.length) || undefined }
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
          mode,
          paceWindowMs: 0
        })
      }
    }
  })

  it('resolves a cap, region, and pool for every wave cell and refuses anything else', () => {
    for (const cellId of SAME_CAP_CELLS) {
      const resolved = resolveCellShape(cellId)
      assert.equal(resolved.status, 0, `${cellId}: ${resolved.stderr}`)
      assert.match(
        resolved.stdout.trim(),
        /^(us-central1 1000 pool=|asia-east2 3000 pool=16)$/,
        cellId
      )
      assert.equal(tfvarsDatabasePoolMax(cellId), cellShape(cellId).pool ?? '10', cellId)
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

  it('paces the drain it sends to the selected cell', () => {
    const drain = workflow.split('--mode drain')[1] ?? ''
    assert.match(drain.split('\n').slice(0, 2).join(' '), /--pace-window-ms "\$\{DRAIN_PACE_WINDOW_MS\}"/)
    assert.match(workflow, /DRAIN_PACE_WINDOW_MS: '120000'/)
    // The transition wait has to outlast the pacing window on top of the leases it waits on.
    assert.match(workflow, /--activity restart-safe[\s\S]*?--timeout-ms 1020000/)
  })

  it('passes this cell\'s rehome protocol and pool on every plan validation the job runs', () => {
    const invocations = workflow.split('validate-relay-capacity-plan.mjs').slice(1)
    assert.equal(invocations.length, 2)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'))
      const call = lines.slice(0, end + 1).join(' ')
      assert.match(call, /--mode same-cap-cell/)
      assert.match(call, /--regional-rehome-protocol "\$\{DESIRED_REHOME_PROTOCOL\}"/)
      assert.match(call, /"\$\{POOL_ARGUMENTS\[@\]\}"/)
    }
    // Each of those steps must build the flag from the resolved pool, and only when there is one.
    const builders = workflow.split(
      'if test -n "${EXPECTED_DATABASE_POOL_MAX}"; then\n' +
        '            POOL_ARGUMENTS=(--database-pool-max "${EXPECTED_DATABASE_POOL_MAX}")'
    )
    assert.equal(builders.length, 3)
    assert.equal(workflow.split('POOL_ARGUMENTS=()').length, 3)
  })

  it('validates a correct plan for every wave cell at that cell\'s rehome protocol', () => {
    for (const [cellId, protocol] of SAME_CAP_CELLS.flatMap((cell) => [[cell, 1], [cell, 3]])) {
      const { cap, pool } = cellShape(cellId)
      assert.equal(REHOME_SOURCE_CELLS.has(cellId), true, cellId)
      const config = {
        mode: 'same-cap-cell',
        cellId,
        hardCap: cap,
        unobservedBound: 60,
        image: TARGET_IMAGE,
        rollbackImage: ROLLBACK_IMAGE,
        rehomeDirectorServiceAccount: DIRECTOR_IDENTITY,
        rehomeAudience: AUDIENCE,
        regionalRehomeProtocol: String(protocol),
        databasePoolMax: pool
      }
      const plan = rollPlan({ cellId, cap, protocol, pool })
      assert.deepEqual(
        validateCapacityPlan(plan, config),
        { mode: 'same-cap-cell', changes: 2 },
        cellId
      )
      // The other protocol must reject the same plan, or the flag decides nothing.
      assert.throws(
        () => validateCapacityPlan(plan, {
          ...config,
          regionalRehomeProtocol: '0'
        }),
        /reviewed image and capacity/,
        cellId
      )
      // Dropping the pin must reject a pinned cell, and adding one must reject a default cell.
      assert.throws(
        () => validateCapacityPlan(plan, {
          ...config,
          databasePoolMax: pool === undefined ? '16' : undefined
        }),
        /reviewed image and capacity/,
        cellId
      )
    }
  })

  it('validates a protocol-0 plan for a cell outside the rehome source list', () => {
    const cellId = 'production-gce-c17'
    assert.equal(REHOME_SOURCE_CELLS.has(cellId), false)
    const config = {
      mode: 'same-cap-cell',
      cellId,
      hardCap: 1000,
      unobservedBound: 60,
      image: TARGET_IMAGE,
      rollbackImage: ROLLBACK_IMAGE,
      rehomeDirectorServiceAccount: DIRECTOR_IDENTITY,
      rehomeAudience: AUDIENCE,
      regionalRehomeProtocol: '0'
    }
    const plan = rollPlan({ cellId, cap: 1000, protocol: 0 })
    assert.deepEqual(validateCapacityPlan(plan, config), { mode: 'same-cap-cell', changes: 2 })
    // Protocol 1 must reject a plan with no rehome lines, or the absent-line rule decides nothing.
    assert.throws(
      () => validateCapacityPlan(plan, { ...config, regionalRehomeProtocol: '1' }),
      /reviewed image and capacity/
    )
  })

  it('leaves the US-only capacity job on the default allowlist', () => {
    assert.doesNotMatch(capacityWorkflow, /--approved-cells/)
  })
})

// Both trusted versions must prove the same authenticated drain boundary.
it('proves rehome trust for protocol 3 on forward and rollback rolls', () => {
  const step = workflow.split('name: Prove exact per-host trust and idempotent no-neighbor behavior')[1].split('\n      - name:')[0]
  assert.match(step, /inputs\.rollback-rehome-protocol != '0'/)
  assert.match(step, /inputs\.target-rehome-protocol != '0'/)
  assert.match(step, /probe-relay-rehome-trust\.mjs/)
})
