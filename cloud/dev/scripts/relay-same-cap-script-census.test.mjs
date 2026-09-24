import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseProductionCapacityCellArguments } from './prepare-relay-production-capacity-canary.mjs'
import {
  SAME_CAP_CELLS,
  SAME_CAP_MIGRATION_ONLY_CELLS,
  entryAdmission,
  selectorWaveDelta
} from './relay-production-same-cap-wave.mjs'
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
const CAPACITY_IDENTITY = 'orca-cloud-gha-cap@onorca-cloud.iam.gserviceaccount.com'
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
  return tfvarsCellBlock(cellId).match(/database_pool_max\s*=\s*(\d+)/)?.[1] ?? '10'
}

function tfvarsHardCap(cellId) {
  const cap = /connection_hard_cap\s*=\s*(\d+)/.exec(tfvarsCellBlock(cellId))?.[1]
  assert.notEqual(cap, undefined, `${cellId} has no connection_hard_cap`)
  return cap
}

function tfvarsCellBlock(cellId) {
  const start = production.indexOf(`"${cellId}" = {`)
  assert.notEqual(start, -1, `${cellId} is missing from production.tfvars`)
  return production.slice(start, production.indexOf('\n  }', start))
}

function startupScript({ cap, image, trusted, pool, capacityIdentity = CAPACITY_IDENTITY }) {
  return [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(capacityIdentity === null
      ? []
      : [`  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`]),
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
function rollPlan({
  cellId, cap, protocol, pool,
  beforeCapacityIdentity = CAPACITY_IDENTITY,
  afterCapacityIdentity = CAPACITY_IDENTITY
}) {
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
              pool: pool === undefined ? undefined : '10',
              capacityIdentity: beforeCapacityIdentity
            })
          },
          after: {
            metadata_startup_script: startupScript({
              cap,
              image: TARGET_IMAGE,
              trusted: protocol >= 1,
              pool,
              capacityIdentity: afterCapacityIdentity
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

// The class block runs before checkout-independent work and decides the whole wave shape.
function resolveCellClass(cellId) {
  return spawnSync('bash', [
    '-euo',
    'pipefail',
    '-c',
    `${jobBlock(
      '          CELL_CLASS="$(node dev/scripts/relay-production-same-cap-wave.mjs cell-class \\',
      '          SELECTOR_WAVE_DELTA="$(jq -er \'.selectorWaveDelta\' <<< "${CELL_CLASS}")"'
    )}\necho "\${ENTRY_ADMISSION} \${SELECTOR_WAVE_DELTA}"`
  ], { cwd: new URL('../..', import.meta.url), env: { ...process.env, TARGET_CELL_ID: cellId }, encoding: 'utf8' })
}

function drainingBlock() {
  return `${jobBlock(
    '          # Rollback is the documented recovery from a failed canary, which',
    '            PREDECESSOR_DRAINING_OK=false\n          fi'
  )}\necho "\${PRECHECK_ADMISSION} \${PRECHECK_DRAINING} \${PREDECESSOR_DRAINING_OK}"`
}

// The three fields gcloud would otherwise default, as the MIG resource declares them.
function migUpdatePolicy() {
  const terraform = readFileSync(
    new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
    'utf8'
  )
  const policy = terraform.split('  update_policy {')[1]?.split('\n  }')[0] ?? ''
  const method = /replacement_method\s+= "([A-Z]+)"/.exec(policy)?.[1]
  assert.notEqual(method, undefined, 'the MIG declares no replacement method')
  // Both fixed bounds come from the topology locals the MIG resource points at.
  const surgeLocal = /max_surge_fixed\s+= local\.relay_gce_topology\.(\w+)/.exec(policy)?.[1]
  const unavailableLocal =
    /max_unavailable_fixed\s+= local\.relay_gce_topology\.(\w+)/.exec(policy)?.[1]
  assert.notEqual(surgeLocal, undefined, 'the MIG pins no surge local')
  assert.notEqual(unavailableLocal, undefined, 'the MIG pins no unavailable local')
  const topology = terraform.split('  relay_gce_topology = {')[1]?.split('\n  }')[0] ?? ''
  const local = (name) => {
    const value = new RegExp(`${name}\\s+= (\\d+)`).exec(topology)?.[1]
    assert.notEqual(value, undefined, `the topology locals pin no ${name}`)
    return value
  }
  return {
    replacementMethod: method.toLowerCase(),
    maxSurge: local(surgeLocal),
    maxUnavailable: local(unavailableLocal)
  }
}

// The stage decides the predecessor, the plan's reviewed rollback image, and whether the
// MIG is rolled explicitly, so run the real block rather than restating its rule.
function stageBlock() {
  return `${jobBlock(
    '          # Two different failures leave the cell on the rollback image, and the image',
    '            PLAN_ROLLBACK_IMAGE="${IMAGE_REPOSITORY}@${CURRENT_IMAGE_DIGEST}"\n          fi'
  )}\necho "\${ROLLBACK_STAGE} \${ROLLBACK_RESUME} \${PREDECESSOR_IMAGE_DIGEST}` +
    ` \${PREDECESSOR_REHOME_PROTOCOL} \${PLAN_ROLLBACK_IMAGE}"`
}

function generationBlock() {
  return `${jobBlock(
    '          if test "${DEPLOY_MODE}" = verify; then',
    '          fi'
  )}\necho "\${EFFECTIVE_SELECTOR_GENERATION}"`
}

// The job derives both memberships in one block; run that block alone for each class.
function membership(env) {
  const script = `${jobBlock(
    '          RESTORED_MIGRATION_CELLS="$(jq -rn \\',
    '          fi'
  )}\njq -cn --arg a "\${ISOLATED_MIGRATION_CELLS}" --arg b "\${ISOLATED_GENERAL_CELLS}" \\
  --arg c "\${RESTORED_MIGRATION_CELLS}" --arg d "\${RESTORED_GENERAL_CELLS}" \\
  '{isolatedMigration:$a,isolatedGeneral:$b,restoredMigration:$c,restoredGeneral:$d}'`
  const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
  assert.equal(resolved.status, 0, resolved.stderr)
  return JSON.parse(resolved.stdout)
}

function jobBlock(firstLine, lastLine) {
  const start = workflow.indexOf(`${firstLine}\n`)
  assert.notEqual(start, -1, `the job has no ${firstLine.trim()}`)
  const end = workflow.indexOf(`\n${lastLine}\n`, start)
  assert.notEqual(end, -1, `that block has no ${lastLine.trim()}`)
  return workflow.slice(start, end + lastLine.length + 1).replace(/^ {10}/gm, '')
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
        /^(us-central1 1000 pool=|us-central1 600 pool=|asia-east2 3000 pool=16)$/,
        cellId
      )
      assert.equal(tfvarsDatabasePoolMax(cellId), cellShape(cellId).pool ?? '10', cellId)
      assert.equal(String(cellShape(cellId).cap), tfvarsHardCap(cellId), cellId)
    }
    assert.equal(resolveCellShape('production-gce-c12').status, 1)
    assert.equal(resolveCellShape('production-gce-c31').status, 1)
  })

  it('passes the same-cap allowlist on every canary invocation the job runs', () => {
    const invocations = workflow.split('prepare-relay-production-capacity-canary.mjs').slice(1)
    assert.equal(invocations.length, 4)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.endsWith('\\'))
      const call = lines.slice(0, end + 1).join(' ')
      assert.match(call, /--approved-cells same-cap/)
      // The restore call picks its mode from the cell's entry admission class.
      assert.match(call, /--mode (isolate|drain|activate|"\$\{RESTORE_MODE\}")/)
    }
  })

  it('paces the drain it sends to the selected cell', () => {
    const drain = workflow.split('--mode drain')[1] ?? ''
    assert.match(drain.split('\n').slice(0, 2).join(' '), /--pace-window-ms "\$\{DRAIN_PACE_WINDOW_MS\}"/)
    // 5 min is the cell's DRAIN_PACE_WINDOW_MAX_MS; a 2,700-host cell at 2 min overruns the director's sticky lane.
    assert.match(workflow, /DRAIN_PACE_WINDOW_MS: '300000'/)
    // The transition wait has to outlast the pacing window on top of the leases it waits on.
    assert.match(workflow, /--activity restart-safe[\s\S]*?--timeout-ms 1200000/)
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

  // One cell's compute path and nothing else: the template and the MIG bound to it. The cell
  // backend service stays out because the capacity role has no compute.backendServices.update,
  // so naming it fails the apply after the MIG has already rolled.
  it('targets exactly this cell template and MIG on every plan the job runs', () => {
    const plans = workflow.split('terraform -chdir=infra/terraform plan').slice(1)
    assert.equal(plans.length, 2)
    for (const plan of plans) {
      const lines = plan.split('\n')
      const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'))
      const call = lines.slice(0, end + 1).join('\n')
      assert.deepEqual(
        [...call.matchAll(/-target=([\w.]+)\[\\"\$\{TARGET_CELL_ID\}\\"\]/g)]
          .map(([, resource]) => resource),
        [
          'google_compute_instance_template.relay_gce_cell',
          'google_compute_instance_group_manager.relay_gce_cell'
        ]
      )
      // Any target that is not one of those two, or not scoped to this cell, fails here.
      assert.equal(call.split('-target=').length, 3)
    }
  })

  it('never names a backend service on any plan or apply in the job', () => {
    assert.equal(workflow.includes('google_compute_backend_service'), false)
  })

  it('validates a correct plan for every wave cell at that cell\'s rehome protocol', () => {
    const trusted = SAME_CAP_CELLS.filter((cell) => REHOME_SOURCE_CELLS.has(cell))
    // Only a declared rehome source may roll at a trusted protocol at all; the job refuses
    // the rest before it plans, and the next test covers them at protocol 0.
    assert.deepEqual(
      SAME_CAP_CELLS.filter((cell) => !REHOME_SOURCE_CELLS.has(cell)),
      SAME_CAP_MIGRATION_ONLY_CELLS
    )
    for (const [cellId, protocol] of trusted.flatMap((cell) => [[cell, 1], [cell, 3]])) {
      const { cap, pool } = cellShape(cellId)
      const config = {
        mode: 'same-cap-cell',
        cellId,
        hardCap: cap,
        unobservedBound: 60,
        image: TARGET_IMAGE,
        rollbackImage: ROLLBACK_IMAGE,
        capacityServiceAccount: CAPACITY_IDENTITY,
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
      hardCap: 600,
      unobservedBound: 60,
      image: TARGET_IMAGE,
      rollbackImage: ROLLBACK_IMAGE,
      capacityServiceAccount: CAPACITY_IDENTITY,
      rehomeDirectorServiceAccount: DIRECTOR_IDENTITY,
      rehomeAudience: AUDIENCE,
      regionalRehomeProtocol: '0'
    }
    const plan = rollPlan({ cellId, cap: 600, protocol: 0 })
    assert.deepEqual(validateCapacityPlan(plan, config), { mode: 'same-cap-cell', changes: 2 })
    // Protocol 1 must reject a plan with no rehome lines, or the absent-line rule decides nothing.
    assert.throws(
      () => validateCapacityPlan(plan, { ...config, regionalRehomeProtocol: '1' }),
      /reviewed image and capacity/
    )
  })

  it('resolves the class and selector delta the wave validator declares', () => {
    for (const cellId of SAME_CAP_CELLS) {
      const resolved = resolveCellClass(cellId)
      assert.equal(resolved.status, 0, `${cellId}: ${resolved.stderr}`)
      assert.equal(
        resolved.stdout.trim(),
        `${entryAdmission(cellId)} ${selectorWaveDelta(cellId)}`,
        cellId
      )
    }
    assert.equal(resolveCellClass('production-gce-c12').status, 1)
  })

  it('offsets a later wave by this cell class\'s own selector delta', () => {
    for (const [waveIndex, delta] of [['0', 2], ['3', 2], ['0', 0], ['3', 0]]) {
      const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', generationBlock()], {
        env: {
          ...process.env,
          DEPLOY_MODE: 'apply',
          EXPECTED_SELECTOR_GENERATION: '40',
          WAVE_INDEX: waveIndex,
          SELECTOR_WAVE_DELTA: String(delta)
        },
        encoding: 'utf8'
      })
      assert.equal(resolved.status, 0, resolved.stderr)
      assert.equal(resolved.stdout.trim(), String(40 + delta * Number(waveIndex)))
    }
  })

  it('hands a migration-only cell back the exact membership it entered with', () => {
    const entry = {
      EXPECTED_MIGRATION_ONLY_CELLS: 'production-gce-c17,production-gce-c18',
      EXPECTED_GENERAL_CELLS: 'production-gce-c7,production-gce-c8'
    }
    const isolated = membership({
      ...entry,
      TARGET_CELL_ID: 'production-gce-c17',
      ENTRY_ADMISSION: 'migration-only'
    })
    assert.deepEqual(isolated, {
      isolatedMigration: 'production-gce-c17,production-gce-c18',
      isolatedGeneral: 'production-gce-c7,production-gce-c8',
      restoredMigration: 'production-gce-c17,production-gce-c18',
      restoredGeneral: 'production-gce-c7,production-gce-c8'
    })
    // A general cell still leaves migration-only and returns to general.
    assert.deepEqual(
      membership({
        ...entry,
        TARGET_CELL_ID: 'production-gce-c7',
        ENTRY_ADMISSION: 'general'
      }),
      {
        isolatedMigration: 'production-gce-c17,production-gce-c18,production-gce-c7',
        isolatedGeneral: 'production-gce-c8',
        restoredMigration: 'production-gce-c17,production-gce-c18',
        restoredGeneral: 'production-gce-c7,production-gce-c8'
      }
    )
  })

  it('never activates a migration-only cell and proves its isolate changed nothing', () => {
    const restore = workflow
      .split('name: Restore only the verified selected cell to its entry admission')[1]
      .split('\n      - id:')[0]
    assert.match(restore, /if test "\$\{ENTRY_ADMISSION\}" = migration-only; then\n\s+RESTORE_MODE=isolate/)
    assert.match(restore, /--admission "\$\{ENTRY_ADMISSION\}"/)
    // The pre-mutation check must demand the class the cell is declared to serve in.
    assert.match(workflow, /PRECHECK_ADMISSION="\$\{ENTRY_ADMISSION\}"/)
    const isolate = workflow
      .split('name: Reversibly isolate and drain only the selected cell')[1]
      .split('\n      - id:')[0]
    assert.match(isolate, /migration-only; then\n\s+jq -e '\.changed == false'/)
  })

  it('requires rehome source membership exactly when a roll carries trust lines', () => {
    const step = workflow
      .split('name: Resolve immutable same-cap cell configuration')[1]
      .split('\n      - name:')[0]
    const guard = step.indexOf('jq -e --arg cell "${TARGET_CELL_ID}" \'index($cell) != null\'')
    assert.notEqual(guard, -1)
    // The guard reads both protocols, so it has to sit after they are resolved.
    assert.ok(step.indexOf('DESIRED_REHOME_PROTOCOL="${TARGET_REHOME_PROTOCOL}"') < guard)
    assert.match(
      step.slice(0, guard),
      /test "\$\{DESIRED_REHOME_PROTOCOL\}" != 0 \|\| test "\$\{CURRENT_REHOME_PROTOCOL\}" != 0\n\s+\}; then\s+$/
    )
  })

  it('rolls a template stale enough to predate the pinned capacity identity', () => {
    // Exactly c17's shape on 2026-09-18: its live template is from 2026-08-07 and has no
    // capacity identity line, so the roll adds one. Run 35290908836 failed closed here.
    const cellId = 'production-gce-c17'
    const config = {
      mode: 'same-cap-cell',
      cellId,
      hardCap: 600,
      unobservedBound: 60,
      image: TARGET_IMAGE,
      rollbackImage: ROLLBACK_IMAGE,
      capacityServiceAccount: CAPACITY_IDENTITY,
      rehomeDirectorServiceAccount: DIRECTOR_IDENTITY,
      rehomeAudience: AUDIENCE,
      regionalRehomeProtocol: '0'
    }
    const stale = rollPlan({ cellId, cap: 600, protocol: 0, beforeCapacityIdentity: null })
    assert.deepEqual(validateCapacityPlan(stale, config), { mode: 'same-cap-cell', changes: 2 })
    // The line may only be gained. A roll may not rewrite it,
    assert.throws(
      () => validateCapacityPlan(stale, {
        ...config,
        capacityServiceAccount: 'orca-cloud-gha-other@onorca-cloud.iam.gserviceaccount.com'
      }),
      /reviewed image and capacity/
    )
    // nor drop it from a template that already carries one.
    assert.throws(
      () => validateCapacityPlan(
        rollPlan({ cellId, cap: 600, protocol: 0, afterCapacityIdentity: null }),
        config
      ),
      /reviewed image and capacity/
    )
    // A same-cap roll cannot run without the identity pinned at all.
    assert.throws(
      () => validateCapacityPlan(stale, { ...config, capacityServiceAccount: undefined }),
      /invalid service account/
    )
  })

  it('pins the capacity identity on every plan validation the job runs', () => {
    const invocations = workflow.split('validate-relay-capacity-plan.mjs').slice(1)
    assert.equal(invocations.length, 2)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'))
      assert.match(
        lines.slice(0, end + 1).join(' '),
        /--capacity-service-account "\$\{CAPACITY_SERVICE_ACCOUNT\}"/
      )
    }
    // Both steps must read it from the same repository variable the job already requires.
    assert.equal(
      workflow.split(
        'CAPACITY_SERVICE_ACCOUNT: ${{ vars.PRODUCTION_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT }}'
      ).length,
      4
    )
  })

  it('decides the predecessor draining rule from the real block, for both classes', () => {
    // A zero-host cell sheds nothing, and a failed canary's own drain leaves the flag set
    // with no restart behind it; run 35292335415 stopped on exactly that residue.
    const cases = [
      // mode, entry class, resume, expected [precheck admission, precheck draining, jq ok]
      ['apply', 'migration-only', 'false', ['migration-only', 'either', 'true']],
      ['apply', 'general', 'false', ['general', 'forbidden', 'false']],
      ['verify', 'migration-only', 'false', ['migration-only', 'either', 'true']],
      ['verify', 'general', 'false', ['general', 'forbidden', 'false']],
      // Every rollback path keeps exactly the behaviour it had.
      ['rollback', 'general', 'false', ['general-or-migration-only', 'either', 'true']],
      ['rollback', 'general', 'true', ['general-or-migration-only', 'either', 'false']],
      ['rollback', 'migration-only', 'false', ['general-or-migration-only', 'either', 'true']],
      ['rollback', 'migration-only', 'true', ['general-or-migration-only', 'either', 'false']]
    ]
    for (const [mode, entry, resume, expected] of cases) {
      const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', drainingBlock()], {
        env: {
          ...process.env,
          DEPLOY_MODE: mode,
          ENTRY_ADMISSION: entry,
          ROLLBACK_RESUME: resume
        },
        encoding: 'utf8'
      })
      assert.equal(resolved.status, 0, `${mode}/${entry}/${resume}: ${resolved.stderr}`)
      assert.deepEqual(
        resolved.stdout.trim().split(' '),
        expected,
        `${mode}/${entry}/${resume}`
      )
    }
  })

  it('reads one draining decision in both predecessor checks', () => {
    const step = workflow
      .split('name: Verify exact current generation, digest, cap, and rollback point')[1]
      .split('\n      - name:')[0]
    // The jq assertion and its diagnostic must not be able to disagree.
    assert.equal(step.split('--argjson drainingOk "${PREDECESSOR_DRAINING_OK}"').length, 3)
    assert.doesNotMatch(step, /drainingOk "\$\(test/)
    // The fresh VM is still required not to be draining, on every path.
    const after = workflow
      .split('name: Verify new incarnation, exact image, protocol, and durable safety')[1]
      .split('\n      - name:')[0]
    assert.match(after, /--admission migration-only --draining forbidden/)
    const restore = workflow
      .split('name: Restore only the verified selected cell to its entry admission')[1]
      .split('\n      - id:')[0]
    assert.match(restore, /--draining forbidden --activity allowed/)
  })

  it('classifies every rollback stage from the real block', () => {
    const repository = 'us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay'
    const target = `sha256:${'7'.repeat(64)}`
    const rollback = `sha256:${'0'.repeat(64)}`
    const stage = (mode, live, draining) => {
      // Exactly how the job assigns them: rollback swaps desired and current.
      const desired = mode === 'rollback' ? rollback : target
      const current = mode === 'rollback' ? target : rollback
      const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', stageBlock()], {
        env: {
          ...process.env,
          DEPLOY_MODE: mode,
          CURRENT_RUNTIME: JSON.stringify({ imageDigest: live, draining }),
          DESIRED_IMAGE_DIGEST: desired,
          CURRENT_IMAGE_DIGEST: current,
          DESIRED_IMAGE: `${repository}@${desired}`,
          IMAGE_REPOSITORY: repository,
          DESIRED_REHOME_PROTOCOL: '1',
          CURRENT_REHOME_PROTOCOL: '0'
        },
        encoding: 'utf8'
      })
      assert.equal(resolved.status, 0, `${mode}/${live}/${draining}: ${resolved.stderr}`)
      return resolved.stdout.trim().split(' ')
    }
    const roll = (current, protocol) =>
      ['roll', 'false', current, protocol, `${repository}@${current}`]
    // Only the last row differs from main: it used to read `resume` and wedge, because the
    // resume path refuses a draining cell and never restarts one.
    assert.deepEqual(stage('apply', rollback, false), roll(rollback, '0'))
    assert.deepEqual(stage('apply', rollback, true), roll(rollback, '0'))
    assert.deepEqual(stage('apply', target, false), roll(rollback, '0'))
    assert.deepEqual(stage('verify', rollback, false), roll(rollback, '0'))
    assert.deepEqual(stage('rollback', target, false), roll(target, '0'))
    assert.deepEqual(stage('rollback', target, true), roll(target, '0'))
    assert.deepEqual(
      stage('rollback', rollback, false),
      ['resume', 'true', rollback, '1', `${repository}@${target}`]
    )
    assert.deepEqual(
      stage('rollback', rollback, true),
      ['stranded', 'false', rollback, '1', `${repository}@${rollback}`]
    )
    // A runtime that reports no drain flag at all must never read as stranded.
    const [missing] = stage('rollback', rollback, null)
    assert.equal(missing, 'resume')
  })

  it('rolls the MIG itself when a stranded plan changes nothing', () => {
    const apply = workflow
      .split('name: Apply only the selected same-cap template and MIG')[1]
      .split('\n      - id:')[0]
    // The plan is reviewed against the image the cell serves, not an assumed predecessor.
    assert.match(apply, /--rollback-image "\$\{PLAN_ROLLBACK_IMAGE\}"/)
    assert.doesNotMatch(apply, /--rollback-image "\$\{IMAGE_REPOSITORY\}/)
    assert.match(
      apply,
      /test "\$\{ROLLBACK_STAGE\}" = stranded \\\n\s+&& test "\$\(jq -er '\.changes' <<< "\$\{PLAN_REVIEW\}"\)" = 0/
    )
    // gcloud persists all three fields into the MIG's update policy and defaults the
    // method to substitute here, so every one has to match what Terraform declares or the
    // recovery drifts the policy and the next targeted plan is refused as an unreviewed
    // MIG change. Read the declared values rather than restating them.
    assert.match(apply, /rolling-action replace "\$\{MIG_NAME\}"/)
    const declared = migUpdatePolicy()
    assert.deepEqual(declared, {
      replacementMethod: 'recreate',
      maxSurge: '0',
      maxUnavailable: '1'
    })
    assert.match(
      apply,
      new RegExp(
        `--replacement-method ${declared.replacementMethod}` +
          ` --max-surge ${declared.maxSurge} --max-unavailable ${declared.maxUnavailable}`
      )
    )
    // Nothing else may reach the group, and the roll has to be waited on.
    assert.equal(apply.split('rolling-action').length, 2)
    assert.equal(apply.split('wait-until "${MIG_NAME}" --stable').length, 3)
  })

  // Run the predicate the job ships rather than restating it, because restating it is how the
  // two drift apart. An unconverged resume accepts the template-and-MIG pair and nothing else,
  // and it applies nothing: a backend change cannot reach this plan, which no longer targets one.
  it('accepts only the template-and-MIG pair on an unconverged resume', () => {
    const step = workflow.slice(
      workflow.indexOf('- name: Require converged Terraform state and a stable MIG on resume'),
      workflow.indexOf('- name: Apply only the selected same-cap template and MIG')
    )
    const accept = /jq -e '(\.changes == 2)' <<< "\$\{RESUME_REVIEW\}"/.exec(step)
    assert.notEqual(accept, null, 'the resume step no longer gates on a validator verdict')
    assert.equal(step.includes('terraform -chdir=infra/terraform apply'), false)
    const outcome = (review) => {
      const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', [
        `RESUME_REVIEW=${JSON.stringify(JSON.stringify(review))}`,
        `jq -e '${accept[1]}' <<< "\${RESUME_REVIEW}" >/dev/null || { echo refuse; exit 0; }`,
        'echo accept'
      ].join('\n')], { encoding: 'utf8' })
      assert.equal(resolved.status, 0, resolved.stderr)
      return resolved.stdout.trim()
    }
    assert.equal(outcome({ changes: 2 }), 'accept')
    // Anything the validator did not bound to the reviewed rollback-image drift fails the step.
    assert.equal(outcome({ changes: 0 }), 'refuse')
    assert.equal(outcome({ changes: 0, backendUpdate: ['log_config.0'] }), 'refuse')
    assert.equal(outcome({ changes: 1 }), 'refuse')
    assert.equal(outcome({ changes: 3 }), 'refuse')
  })

  // The stranded cell's explicit MIG roll is the only thing that clears its drain flag, and
  // `changes` is what decides it, so run the shipped predicate rather than restating it.
  it('rolls a stranded MIG on the shipped predicate', () => {
    const apply = workflow
      .split('name: Apply only the selected same-cap template and MIG')[1]
      .split('\n      - id:')[0]
    const condition =
      /if test "\$\{ROLLBACK_STAGE\}" = stranded \\\n\s+(&& test "\$\(jq -er '\.changes' <<< "\$\{PLAN_REVIEW\}"\)" = 0); then/
        .exec(apply)
    assert.notEqual(condition, null, 'the stranded roll no longer gates on the plan review')
    const rolls = (stage, review) => {
      const resolved = spawnSync('bash', ['-euo', 'pipefail', '-c', [
        `ROLLBACK_STAGE=${stage}`,
        `PLAN_REVIEW=${JSON.stringify(JSON.stringify(review))}`,
        `if test "\${ROLLBACK_STAGE}" = stranded \\\n  ${condition[1]}; then`,
        'echo replace; else echo no-replace; fi'
      ].join('\n')], { encoding: 'utf8' })
      assert.equal(resolved.status, 0, resolved.stderr)
      return resolved.stdout.trim()
    }
    assert.equal(rolls('stranded', { changes: 0 }), 'replace')
    // A real template replacement already restarts the instance; rolling again would be a second.
    assert.equal(rolls('stranded', { changes: 2 }), 'no-replace')
    assert.equal(rolls('resume', { changes: 0 }), 'no-replace')
    assert.equal(rolls('none', { changes: 0 }), 'no-replace')
  })

  it('waits on the image a stranded cell actually serves', () => {
    const isolate = workflow
      .split('name: Reversibly isolate and drain only the selected cell')[1]
      .split('\n      - id:')[0]
    assert.match(isolate, /--expected-image-digests "\$\{PREDECESSOR_IMAGE_DIGEST\}"/)
    // A stranded cell has to come back on a new process, which is what clears the drain.
    const after = workflow
      .split('name: Verify new incarnation, exact image, protocol, and durable safety')[1]
      .split('\n      - name:')[0]
    assert.match(after, /test "\$\{TARGET_INCARNATION\}" != "\$\{SOURCE_INCARNATION\}"/)
    assert.match(after, /if test "\$\{ROLLBACK_RESUME\}" = true; then/)
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
