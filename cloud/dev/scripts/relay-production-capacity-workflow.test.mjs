import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readRelayWorkflow, relayWorkflowPath } from './relay-repository.mjs'
import { PRODUCTION_CAPACITY_CELL_IDS } from './prepare-relay-production-capacity-canary.mjs'

const dispatchWorkflow = readRelayWorkflow('deploy-relay-production-capacity.yml')
const workflow = readRelayWorkflow('deploy-relay-production-capacity-job.yml')
const terraform = source('infra/terraform/relay-github-actions.tf')
const production = source('infra/terraform/environments/production.tfvars')
const capacityCells = PRODUCTION_CAPACITY_CELL_IDS

function source(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

function resource(type, name) {
  const start = terraform.indexOf(`resource "${type}" "${name}"`)
  assert.notEqual(start, -1, `${type}.${name} is missing`)
  const next = terraform.indexOf('\nresource "', start + 1)
  return terraform.slice(start, next === -1 ? undefined : next)
}

function ordered(...markers) {
  let previous = -1
  for (const marker of markers) {
    const current = workflow.indexOf(marker)
    assert.ok(current > previous, `${marker} is missing or out of order`)
    previous = current
  }
}

function mutationConfirmation(mode, targetCellId, confirmation) {
  const stepStart = workflow.indexOf('      - name: Require exact mutation confirmation')
  const runMarker = '        run: |\n'
  const runStart = workflow.indexOf(runMarker, stepStart) + runMarker.length
  const runEnd = workflow.indexOf('\n      - name:', runStart)
  const script = workflow.slice(runStart, runEnd).replace(/^ {10}/gm, '')
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    env: {
      ...process.env,
      DEPLOY_MODE: mode,
      TARGET_CELL_ID: targetCellId,
      CONFIRMATION: confirmation
    }
  }).status
}

function imageCompatibility(activeImage, desiredImage) {
  const start = workflow.indexOf('          ACTIVE_IMAGE_DIGEST="${ACTIVE_IMAGE##*@}"')
  const end = workflow.indexOf('\n          CURRENT_CELLS_JSON=', start)
  const script = workflow.slice(start, end).replace(/^ {10}/gm, '')
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    env: {
      ...process.env,
      ACTIVE_IMAGE: activeImage,
      DESIRED_IMAGE: desiredImage,
      DESIRED_IMAGE_DIGEST: desiredImage.split('@').at(-1),
      COMPATIBLE_DIRECTOR_IMAGE_DIGEST: 'sha256:01b7fc3e6dce66180034f268a2dc92c05458706c5b3a0dc4450dcdd6161f6e73',
      COMPATIBLE_CELL_IMAGE_DIGEST: 'sha256:c77ec7aef565009fdb645b0989806859bfa40a7aa14e4a57ab55ac92fee6c34f'
    }
  }).status
}

test('production capacity mutation is restricted to the exact serving rollout set', () => {
  assert.match(workflow, /TARGET_CELL_ID: \$\{\{ inputs\.target-cell-id \}\}/)
  const targetInput = dispatchWorkflow.slice(
    dispatchWorkflow.indexOf('      target-cell-id:'),
    dispatchWorkflow.indexOf('      wave-cell-ids:')
  )
  assert.deepEqual(
    [...targetInput.matchAll(/^\s+- (production-gce-c\d+)$/gm)].map((match) => match[1]),
    capacityCells
  )
  assert.match(workflow, new RegExp(`CAPACITY_CELL_IDS: ${capacityCells.join(',')}`))
  for (const cellId of capacityCells) {
    assert.match(dispatchWorkflow, new RegExp(`^\\s+- ${cellId}$`, 'm'))
  }
  assert.match(workflow, /CELL_ORIGIN="https:\/\/\$\{TARGET_HOSTNAME\}\.relay\.onorca\.dev"/)
  assert.match(workflow, /echo "TARGET_HOSTNAME=\$\{TARGET_HOSTNAME\}"/)
  assert.match(workflow, /\} >> "\$\{GITHUB_ENV\}"/)
  assert.match(workflow, /RAISE_SELECTED_CELL_TO_1000/)
  assert.match(workflow, /ROLL_BACK_SELECTED_CELL_TO_600/)
  assert.match(workflow, /TARGET_HARD_CAP=600[\s\S]*?else[\s\S]*?TARGET_HARD_CAP=1000/)
})

test('rollback confirmation is bound to the exact selected cell', () => {
  assert.equal(
    mutationConfirmation('apply', 'production-gce-c25', 'RAISE_SELECTED_CELL_TO_1000'),
    0
  )
  assert.equal(
    mutationConfirmation(
      'rollback',
      'production-gce-c25',
      'ROLL_BACK_SELECTED_CELL_TO_600 production-gce-c25'
    ),
    0
  )
  assert.notEqual(
    mutationConfirmation('rollback', 'production-gce-c25', 'ROLL_BACK_SELECTED_CELL_TO_600'),
    0
  )
  assert.notEqual(
    mutationConfirmation(
      'rollback',
      'production-gce-c25',
      'ROLL_BACK_SELECTED_CELL_TO_600 production-gce-c26'
    ),
    0
  )
})

test('production configuration selects only serving cells for 1,000 and the compatible image', () => {
  const cell = (cellId) => production.slice(
    production.indexOf(`"${cellId}"`),
    production.indexOf('\n  }', production.indexOf(`"${cellId}"`))
  )
  for (const cellId of capacityCells) {
    assert.match(cell(cellId), /connection_hard_cap\s+= 1000/)
    assert.match(
      cell(cellId),
      /sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563/
    )
  }
  for (const cellId of ['production-gce-c17', 'production-gce-c18']) {
    assert.match(cell(cellId), /connection_hard_cap\s+= 600/)
    assert.doesNotMatch(cell(cellId), /connection_hard_cap\s+= 1000/)
    assert.match(cell(cellId), /sha256:0e83408b0dc08531f1e8182019dc151afc38d63ddde4ad5cc01e40247ef3681d/)
  }
  assert.equal(production.match(/connection_hard_cap\s+= 1000/g)?.length, capacityCells.length)
  // Asia cells legitimately share this digest, so scope the uniqueness check to the capacity set.
  assert.equal(
    new Set(capacityCells.map((cellId) => cell(cellId).match(/sha256:[0-9a-f]{64}/)[0])).size,
    1
  )
  assert.match(
    workflow,
    /COMPATIBLE_DIRECTOR_IMAGE_DIGEST: sha256:01b7fc3e6dce66180034f268a2dc92c05458706c5b3a0dc4450dcdd6161f6e73/
  )
  assert.match(
    workflow,
    /test "\$\{ACTIVE_IMAGE_DIGEST\}" = "\$\{COMPATIBLE_DIRECTOR_IMAGE_DIGEST\}"/
  )
  assert.match(
    workflow,
    /test "\$\{DESIRED_IMAGE_DIGEST\}" = "\$\{COMPATIBLE_CELL_IMAGE_DIGEST\}"/
  )
  assert.match(workflow, /\.\[\$cell\]\.connection_hard_cap = \$cap/)
  assert.match(workflow, /baseCells:\$baseCells/)
  assert.match(workflow, /capacityCellIds:\(\$capacityCellIds \| split\(","\)\)/)
  assert.match(
    workflow,
    /Verify current selected-cell capacity[\s\S]*?TOPOLOGY_PHASE.*predecessor[\s\S]*?CURRENT_CAP=600[\s\S]*?DESIRED_IMAGE_DIGEST.*PREDECESSOR_IMAGE_DIGEST/
  )
})

test('director and cell image compatibility is an exact reviewed pair', () => {
  const repository = 'us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@'
  const director = `${repository}sha256:01b7fc3e6dce66180034f268a2dc92c05458706c5b3a0dc4450dcdd6161f6e73`
  const cell = `${repository}sha256:c77ec7aef565009fdb645b0989806859bfa40a7aa14e4a57ab55ac92fee6c34f`
  const other = `${repository}sha256:${'a'.repeat(64)}`
  assert.equal(imageCompatibility(cell, cell), 0)
  assert.equal(imageCompatibility(director, cell), 0)
  assert.notEqual(imageCompatibility(director, other), 0)
  assert.notEqual(imageCompatibility(other, cell), 0)
})

// The matching check on google_project_service.required lives with the foundation root, which
// stays in the private repository.

test('apply consumes fresh evidence before arming mutation cleanup', () => {
  for (const marker of [
    'Require fresh dry-run evidence reference',
    'Verify dry-run artifact before cloud authentication',
    'Reject previously consumed dry-run evidence',
    'Verify fresh dry-run evidence against the live selector',
    'Recheck every live safety signal',
    'Publish the consumed-evidence marker'
  ]) {
    assert.match(workflow, new RegExp(marker))
  }
  assert.match(workflow, /--mutation-mode capacity-transition/)
  assert.match(workflow, /--source-cell-id "\$\{TARGET_CELL_ID\}"/)
  ordered(
    'Publish the consumed-evidence marker',
    'Arm fail-closed mutation cleanup',
    'Reversibly isolate only the selected cell',
    'Deploy only the reviewed director topology',
    'Plan and apply only the empty selected cell',
    'Restore only the selected cell to general admission',
    'Verify the live general selected cell'
  )
})

test('wave apply consumes one proof and runs fail-closed cells sequentially', () => {
  assert.match(dispatchWorkflow, /- wave-apply/)
  assert.match(dispatchWorkflow, /group: production-cloud-sql-rollout/)
  assert.match(dispatchWorkflow, /Validate the exact wave request/)
  assert.match(dispatchWorkflow, /Verify wave evidence against the live selector/)
  assert.match(dispatchWorkflow, /Require exact 600\/60 predecessor wave cells/)
  assert.match(
    dispatchWorkflow,
    /COMPATIBLE_CELL_IMAGE_DIGEST: sha256:c77ec7aef565009fdb645b0989806859bfa40a7aa14e4a57ab55ac92fee6c34f/
  )
  assert.match(
    dispatchWorkflow,
    /Require exact 600\/60 predecessor wave cells[\s\S]*?--expected-image-digests \\\n\s+"\$\{PREDECESSOR_IMAGE_DIGEST\},\$\{COMPATIBLE_CELL_IMAGE_DIGEST\}"/
  )
  assert.match(dispatchWorkflow, /Publish the consumed-evidence marker/)
  assert.match(
    dispatchWorkflow,
    /OUTPUT_DIRECTORY: \$\{\{ github\.workspace \}\}\/relay-monitor-evidence/
  )
  assert.match(
    dispatchWorkflow,
    /path: \$\{\{ github\.workspace \}\}\/relay-monitor-evidence/
  )
  assert.doesNotMatch(dispatchWorkflow, /strategy:/)
  for (const [index, dependency] of [
    [1, 'wave_gate'],
    [2, 'wave_cell_1'],
    [3, 'wave_cell_2'],
    [4, 'wave_cell_3']
  ]) {
    const start = dispatchWorkflow.indexOf(`  wave_cell_${index}:`)
    const end = dispatchWorkflow.indexOf(`\n  wave_cell_${index + 1}:`, start)
    const job = dispatchWorkflow.slice(start, end === -1 ? undefined : end)
    assert.match(job, new RegExp(`needs: (?:\\[wave_gate, )?${dependency}`))
    assert.match(job, /evidence-mode: continuation/)
    assert.match(job, new RegExp(`wave-index: '${index - 1}'`))
  }
  assert.match(workflow, /Download this workflow's wave authority/)
  assert.match(workflow, /run-id: \$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /relay-production-capacity-wave\.mjs build-preflight/)
  assert.match(workflow, /Require the exact wave predecessor topology/)
  assert.match(workflow, /test "\$\{TOPOLOGY_PHASE\}" = predecessor/)
  assert.match(workflow, /Recheck exact wave state and every live safety signal/)
  assert.match(workflow, /if test "\$\{WAVE_INDEX\}" != 0; then RETRY_ARGS=\(--retry-freshness\); fi/)
  assert.equal(workflow.match(/--retry-freshness/g)?.length, 2)
  ordered(
    'Recheck exact wave state and every live safety signal',
    'Arm fail-closed mutation cleanup',
    'Reversibly isolate only the selected cell',
    'Verify the live general selected cell'
  )
})

test('Terraform mutation targets only the selected cell and has fail-closed recovery', () => {
  assert.match(
    workflow,
    /google_compute_instance_template\.relay_gce_cell\[\\"\$\{TARGET_CELL_ID\}\\"\]/
  )
  assert.match(
    workflow,
    /google_compute_instance_group_manager\.relay_gce_cell\[\\"\$\{TARGET_CELL_ID\}\\"\]/
  )
  assert.doesNotMatch(workflow, /relay_gce_cell\["production-gce-c26"\]/)
  assert.doesNotMatch(workflow, /target=google_cloud_run_v2_service\.relay/)
  assert.match(workflow, /validate-relay-capacity-plan\.mjs/)
  assert.match(workflow, /--mode bootstrap-cell/)
  assert.match(workflow, /--capacity-service-account "\$\{CAPACITY_SERVICE_ACCOUNT\}"/)
  assert.match(workflow, /failure\(\) && inputs\.mode != 'verify'/)
  assert.match(workflow, /test "\$\{MUTATION_STARTED:-false\}" = true \|\| exit 0/)
  assert.match(workflow, /--mode isolate/)
  assert.doesNotMatch(workflow, /rolling-action restart/)
  assert.doesNotMatch(workflow, /manage_artifact_dns/)
  assert.match(workflow, /OFFLINE_ROLLBACK=true/)
  assert.match(workflow, /--runtime unavailable/)
  assert.equal(workflow.match(/--expected-image-digests/g)?.length, 7)
  assert.match(workflow, /PREDECESSOR_IMAGE_DIGEST: sha256:0e83408b/)
  assert.match(workflow, /classify-relay-production-capacity-director\.mjs/)
  assert.match(workflow, /CURRENT_CAPACITY_SERVICE_ACCOUNT_JSON/)
  assert.match(workflow, /if test "\$\{DIRECTOR_READY\}" = true; then exit 0; fi/)
  assert.match(
    workflow,
    /Keep the selected cell isolated after a failed mutation[\s\S]*?--mode isolate[\s\S]*?--mode drain/
  )
  const cleanup = workflow.slice(workflow.indexOf('id: cleanup-auth'))
  assert.match(cleanup, /Keep the selected cell isolated after a failed mutation/)
  assert.match(cleanup, /steps\.cleanup-auth\.outputs\.id_token/)
  assert.doesNotMatch(cleanup, /steps\.deploy-auth\.outputs\.id_token/)
  ordered(
    'Reversibly isolate only the selected cell',
    'Drain the selected cell or prove an offline rollback',
    'id: restart-auth-one',
    'Require restart-safe selected-cell activity',
    'id: restart-auth-two',
    'Require extended restart-safe selected-cell activity',
    'Deploy only the reviewed director topology',
    'id: director-transition-auth',
    'Require fail-closed director transition',
    'id: capacity-auth',
    'Plan and apply only the empty selected cell',
    'id: capacity-transition-auth',
    'Verify fresh exact selected-cell heartbeat before admission'
  )
  const restartGate = workflow.slice(
    workflow.indexOf('id: restart-auth-one'),
    workflow.indexOf('Deploy only the reviewed director topology')
  )
  assert.equal(restartGate.match(/--timeout-ms 450000/g)?.length, 2)
  assert.match(restartGate, /steps\.restart-auth-one\.outputs\.id_token/)
  assert.match(restartGate, /steps\.restart-auth-two\.outputs\.id_token/)
  assert.match(restartGate, /capacity transition verification timed out:/)
  assert.match(workflow, /timeout-minutes: 75/)
})

test('wave resume is bound to the failed run and exact isolated selector state', () => {
  assert.match(dispatchWorkflow, /- wave-resume/)
  assert.match(dispatchWorkflow, /evidence-mode: resume/)
  assert.match(dispatchWorkflow, /source-wave-run-id: \$\{\{ inputs\.source-wave-run-id \}\}/)
  assert.match(workflow, /Download the failed wave authority for resume/)
  assert.match(workflow, /test "\$\{SOURCE_SHA\}" = "\$\{MONITOR_SHA\}"/)
  assert.match(workflow, /test "\$\{SOURCE_ATTEMPT\}" = "\$\{EXPECTED_SOURCE_ATTEMPT\}"/)
  for (const boundary of [
    '31554591366:31555510376:production-gce-c16,production-gce-c15,production-gce-c14,production-gce-c13:production-gce-c13',
    '31562760783:31563664692:production-gce-c10,production-gce-c9,production-gce-c8,production-gce-c7:production-gce-c10',
    '31571019947:31572080665:production-gce-c9,production-gce-c8,production-gce-c7:production-gce-c8',
    'a917e8e1fc1a2654e8cb81ba39b57733ec56be9c',
    '6082e9ca89a918ca51f0c87db003f5e8805b64b7',
    'e59958130c9d9b7a6cd805df2678d08997842c7c',
    'EXPECTED_SOURCE_ATTEMPT=2'
  ]) {
    assert.match(workflow, new RegExp(boundary))
  }
  assert.match(workflow, /\*\) exit 1 ;;/)
  assert.match(workflow, /test "\$\{MONITOR_SHA\}" = "\$\{EXPECTED_SHA\}"/)
  assert.match(workflow, /\.head_branch == "main"/)
  assert.match(workflow, /\.head_repository\.full_name == env\.GITHUB_REPOSITORY/)
  assert.ok(workflow.includes(`.path == "${relayWorkflowPath('monitor-relay-production.yml')}"`))
  assert.ok(workflow.includes(`.path == "${relayWorkflowPath('deploy-relay-production-capacity.yml')}"`))
  assert.match(workflow, /build-resume-preflight/)
  assert.match(workflow, /RESUME_SELECTED_CELL_TO_1000 \$\{TARGET_CELL_ID\}/)
  assert.match(
    workflow,
    /Recheck exact isolated resume state[\s\S]*?--hard-cap 600[\s\S]*?--admission migration-only[\s\S]*?--draining required/
  )
})

test('GCE capacity identity is exact-workflow and narrowly permissioned', () => {
  const provider = resource(
    'google_iam_workload_identity_pool_provider',
    'github_production_relay_capacity'
  )
  assert.match(provider, /concat\(local\.relay_github_leading_repository_claims, \[/)
  for (const boundary of [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'production'",
    'local.relay_github_workflow_conditions["github_production_relay_capacity"]'
  ]) {
    assert.match(provider, new RegExp(boundary.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  // The workflow pair itself is pinned in the clause the provider renders, once per accepted
  // repository, and each repository supplies its own workflow-ref head.
  for (const boundary of [
    "assertion.workflow_ref == '${prefix}${local.github_production_relay_capacity_workflow_file}@refs/heads/main'",
    "assertion.job_workflow_ref == '${prefix}${local.github_production_relay_capacity_job_workflow_file}@refs/heads/main'"
  ]) {
    assert.match(terraform, new RegExp(boundary.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const role = resource(
    'google_project_iam_custom_role',
    'github_production_relay_capacity_mutation'
  )
  assert.match(role, /compute\.instanceGroupManagers\.update/)
  assert.match(role, /compute\.instanceTemplates\.create/)
  assert.doesNotMatch(
    role,
    /compute\.(?:disks\.delete|instances\.(?:delete|start|stop|update))|cloudsql|secretmanager/
  )
  const state = resource(
    'google_storage_bucket_iam_member',
    'github_production_relay_capacity_state'
  )
  assert.match(state, /objects\/terraform\/state\/default\.tfstate/)
  assert.match(state, /objects\/terraform\/state\/default\.tflock/)
})

test('deploy and capacity identities are used in their intended phases', () => {
  const jobStart = workflow.indexOf('  capacity:')
  const stepsStart = workflow.indexOf('    steps:', jobStart)
  const jobHeader = workflow.slice(jobStart, stepsStart)
  assert.deepEqual(jobHeader.match(/^\s+if:.*$/gm), [
    "    if: ${{ github.ref == 'refs/heads/main' }}"
  ])
  const configurationStart = workflow.indexOf('Require production workflow configuration')
  const configurationEnd = workflow.indexOf('- uses: actions/checkout@v4', configurationStart)
  assert.ok(configurationStart >= 0)
  assert.ok(configurationEnd > configurationStart)
  const configurationStep = workflow.slice(configurationStart, configurationEnd)
  for (const name of [
    'GCP_REGION',
    'DEPLOY_WORKLOAD_IDENTITY_PROVIDER',
    'DEPLOY_SERVICE_ACCOUNT',
    'CAPACITY_WORKLOAD_IDENTITY_PROVIDER',
    'CAPACITY_SERVICE_ACCOUNT'
  ]) {
    assert.match(configurationStep, new RegExp(`test -n "\\$\\{${name}\\}"`))
  }
  ordered('Require production workflow configuration', 'id: deploy-auth')
  ordered('id: deploy-auth', 'Reversibly isolate only the selected cell', 'id: capacity-auth')
  assert.match(workflow, /steps\.deploy-auth\.outputs\.id_token/)
  assert.doesNotMatch(workflow, /steps\.capacity-auth\.outputs\.id_token/)
  assert.equal(
    workflow.match(/steps\.capacity-transition-auth\.outputs\.id_token/g)?.length,
    3
  )
  assert.match(workflow, /PRODUCTION_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(workflow, /PRODUCTION_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT/)
  assert.match(workflow, /read-relay-production-capacity-identity\.mjs/)
  assert.match(workflow, /\(\.directorReady \| type\) == "boolean"/)
  assert.match(workflow, /\(\.directorReady \| tostring\)/)
})

test('director readiness extraction preserves only JSON booleans', {
  skip: spawnSync('jq', ['--version']).status !== 0
}, () => {
  const filter = `if (.directorReady | type) == "boolean" then
    (.directorReady | tostring)
    else error("invalid directorReady classification") end`
  const extract = (input) => spawnSync('jq', ['-er', filter], {
    encoding: 'utf8',
    input: JSON.stringify(input)
  })
  for (const value of [true, false]) {
    const result = extract({ directorReady: value })
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), String(value))
  }
  for (const input of [
    { directorReady: 'true' },
    { directorReady: 'false' },
    { directorReady: null },
    {}
  ]) {
    assert.notEqual(extract(input).status, 0)
  }
})
