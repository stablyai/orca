import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { relayWorkflowUrl } from './relay-repository.mjs'

const terraform = readFileSync(
  new URL('../../infra/terraform/relay-github-actions.tf', import.meta.url),
  'utf8'
)
const outputs = readFileSync(new URL('../../infra/terraform/outputs.tf', import.meta.url), 'utf8')
const workflow = readFileSync(
  relayWorkflowUrl('prove-relay-staging-capacity.yml'),
  'utf8'
)
const deployWorkflow = readFileSync(
  relayWorkflowUrl('deploy-relay-staging.yml'),
  'utf8'
)
const publishWorkflow = readFileSync(
  relayWorkflowUrl('publish-relay-production.yml'),
  'utf8'
)
const bootstrapWorkflow = readFileSync(
  relayWorkflowUrl('bootstrap-relay-staging-capacity.yml'),
  'utf8'
)

function resource(type, name) {
  const start = terraform.indexOf(`resource "${type}" "${name}"`)
  assert.notEqual(start, -1, `${type}.${name} is missing`)
  const next = terraform.indexOf('\nresource "', start + 1)
  return terraform.slice(start, next === -1 ? undefined : next)
}

function terraformStringList(block, attribute) {
  const match = block.match(new RegExp(`${attribute}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  assert.ok(match, `${attribute} is missing`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
}

test('capacity workflow uses only its exact staging identity', () => {
  assert.match(workflow, /STAGING_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(workflow, /STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT/)
  assert.doesNotMatch(workflow, /vars\.STAGING_GCP_WORKLOAD_IDENTITY_PROVIDER/)
  assert.doesNotMatch(workflow, /vars\.STAGING_GCP_DEPLOY_SERVICE_ACCOUNT/)

  const provider = resource(
    'google_iam_workload_identity_pool_provider',
    'github_staging_relay_capacity'
  )
  // The three repository claims are pinned once in relay-shared.tf; every provider concatenates
  // that list rather than restating the repository on its own.
  assert.match(provider, /concat\(local\.relay_github_leading_repository_claims, \[/)
  for (const boundary of [
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'staging'"
  ]) {
    assert.match(provider, new RegExp(boundary.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(provider, /local\.relay_github_workflow_conditions\["github_staging_relay_capacity"\]/)
  assert.deepEqual(
    terraformStringList(terraform, 'github_staging_relay_capacity_workflow_files'),
    [
      'bootstrap-relay-staging-capacity.yml',
      'prove-relay-staging-capacity.yml',
      'recover-relay-staging-c4-image.yml'
    ]
  )
  assert.match(
    terraform,
    /for workflow_file in local\.github_staging_relay_capacity_workflow_files : "assertion\.workflow_ref == '\$\{prefix\}\$\{workflow_file\}@refs\/heads\/main'"/
  )
  assert.doesNotMatch(terraform, /github_staging_relay_capacity_workflow_file\s*=/)
})

test('job gates do not read environment variables before the environment is attached', () => {
  for (const source of [workflow, deployWorkflow, bootstrapWorkflow]) {
    const jobGate = source.match(/^\s{4}if:.*$/m)?.[0] ?? ''
    assert.doesNotMatch(jobGate, /STAGING_GCP_RELAY_CAPACITY_/)
  }
})

test('capacity identity has bounded mutation and state permissions', () => {
  const role = resource(
    'google_project_iam_custom_role',
    'github_staging_relay_capacity_mutation'
  )
  assert.deepEqual(terraformStringList(role, 'permissions'), [
    'compute.disks.create',
    'compute.healthChecks.use',
    'compute.images.useReadOnly',
    'compute.instanceGroupManagers.get',
    'compute.instanceGroupManagers.update',
    'compute.instances.create',
    'compute.instances.setLabels',
    'compute.instances.setMetadata',
    'compute.instances.setTags',
    'compute.instanceTemplates.create',
    'compute.instanceTemplates.delete',
    'compute.instanceTemplates.get',
    'compute.instanceTemplates.useReadOnly',
    'compute.networks.use',
    'compute.subnetworks.use',
    'compute.zoneOperations.get'
  ])
  assert.doesNotMatch(
    role,
    /compute\.(?:disks\.delete|instances\.(?:delete|start|stop|update))|cloudsql|secretmanager/
  )

  for (const source of [workflow, bootstrapWorkflow]) {
    assert.match(source, /instance-groups managed recreate-instances/)
    assert.match(source, /--instances/)
    assert.doesNotMatch(source, /rolling-action restart/)
  }

  const state = resource(
    'google_storage_bucket_iam_member',
    'github_staging_relay_capacity_state'
  )
  assert.match(state, /roles\/storage\.objectAdmin/)
  assert.match(state, /objects\/terraform\/state\/default\.tfstate/)
  assert.match(state, /objects\/terraform\/state\/default\.tflock/)
  assert.doesNotMatch(state, /resource\.name\.startsWith/)

  const runtime = resource(
    'google_service_account_iam_member',
    'github_staging_relay_capacity_runtime_user'
  )
  assert.match(runtime, /google_service_account\.relay_runtime\.name/)
  assert.match(runtime, /roles\/iam\.serviceAccountUser/)

  const cloudRun = resource(
    'google_cloud_run_v2_service_iam_member',
    'github_staging_relay_capacity_developer'
  )
  assert.match(cloudRun, /name\s*=\s*var\.relay_cloud_run_service_name/)
  assert.doesNotMatch(cloudRun, /google_cloud_run_v2_service\.relay/)

  const relay = readFileSync(new URL('../../infra/terraform/relay.tf', import.meta.url), 'utf8')
  const startup = readFileSync(
    new URL('../../infra/terraform/relay-gce-startup.sh.tftpl', import.meta.url),
    'utf8'
  )
  assert.match(relay, /ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT/)
  assert.match(startup, /ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT/)
})

test('capacity identity exposes only its provider and service account', () => {
  assert.match(outputs, /output "github_staging_relay_capacity_workload_identity_provider"/)
  assert.match(outputs, /output "github_staging_relay_capacity_service_account"/)
})

test('director capacity configuration stays on the audited blue-green path', () => {
  assert.match(deployWorkflow, /STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT/)
  assert.match(deployWorkflow, /--capacity-service-account "\$\{CAPACITY_SERVICE_ACCOUNT\}"/)
  assert.match(deployWorkflow, /expected-image-digest/)
  assert.match(deployWorkflow, /var\.relay_gce_cells\["staging-gce-c4"\]\.image/)
  assert.match(deployWorkflow, /init -reconfigure \\\n\s+-backend-config=backend\/staging\.hcl/)
  assert.ok(
    deployWorkflow.indexOf('id: google-auth') <
      deployWorkflow.indexOf('Bind the request to the checked-in staging C4 image')
  )
  assert.match(deployWorkflow, /artifacts docker images describe "\$\{IMAGE\}"/)
  assert.doesNotMatch(deployWorkflow, /docker (?:build|push)/)
  assert.match(workflow, /--director-cells-json "\$\{DESIRED_CELLS_JSON\}"/)
  assert.doesNotMatch(workflow, /target=google_cloud_run_v2_service\.relay/)
  assert.doesNotMatch(workflow, /--mode director/)
})

test('mirrors the exact production manifest through the production deploy identity', () => {
  assert.match(publishWorkflow, /options: \[publish, mirror-staging\]/)
  assert.match(publishWorkflow, /MIRROR_RELAY_PRODUCTION_IMAGE_TO_STAGING/)
  assert.match(publishWorkflow, /docker pull "\$\{source_image\}"/)
  assert.match(publishWorkflow, /docker tag "\$\{source_image\}" "\$\{target_tag\}"/)
  assert.match(publishWorkflow, /test "\$\{source_digest\}" = "\$\{MIRROR_DIGEST\}"/)
  assert.match(publishWorkflow, /test "\$\{target_digest\}" = "\$\{MIRROR_DIGEST\}"/)
  const mirrorWriter = resource(
    'google_artifact_registry_repository_iam_member',
    'github_production_relay_staging_mirror_writer'
  )
  assert.match(mirrorWriter, /var\.environment == "staging"/)
  assert.match(mirrorWriter, /roles\/artifactregistry\.writer/)
  assert.match(
    mirrorWriter,
    /serviceAccount:orca-cloud-gha-deploy@onorca-cloud\.iam\.gserviceaccount\.com/
  )
})

test('cells bootstrap one at a time with bounded deploy and capacity identities', () => {
  assert.match(bootstrapWorkflow, /STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(bootstrapWorkflow, /STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT/)
  assert.match(bootstrapWorkflow, /STAGING_GCP_RELAY_CAPACITY_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(bootstrapWorkflow, /STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT/)
  assert.match(bootstrapWorkflow, /--mode bootstrap-cell/)
  assert.match(bootstrapWorkflow, /--cell-id "\$\{fallback_cell_id\}"/)
  assert.match(bootstrapWorkflow, /google_compute_instance_template\.relay_gce_cell/)
  assert.match(bootstrapWorkflow, /google_compute_instance_group_manager\.relay_gce_cell/)
  assert.match(bootstrapWorkflow, /--mode restore-fallback/)
  assert.doesNotMatch(bootstrapWorkflow, /target=google_cloud_run_v2_service\.relay/)
  assert.ok(
    bootstrapWorkflow.indexOf('id: deploy-auth') < bootstrapWorkflow.indexOf('id: capacity-auth')
  )
  assert.match(
    bootstrapWorkflow,
    /restore_fallback\(\) \{[\s\S]*?verify_fallback[\s\S]*?--mode restore-fallback/
  )
  const rollCell = bootstrapWorkflow.slice(bootstrapWorkflow.indexOf('roll_cell()'))
  assert.ok(
    rollCell.indexOf('verify_fallback\n            trap restore_fallback EXIT') <
      rollCell.indexOf('--mode isolate')
  )
  assert.match(
    bootstrapWorkflow,
    /staging-gce-c2 general[\s\S]*?trap restore_legacy_c3_fallback EXIT[\s\S]*?--mode isolate/
  )
  const normalize = bootstrapWorkflow.slice(
    bootstrapWorkflow.indexOf('normalize_legacy_c3() {'),
    bootstrapWorkflow.indexOf('\n          roll_cell()', bootstrapWorkflow.indexOf('normalize_legacy_c3() {'))
  )
  const trapInstalled = normalize.indexOf('trap restore_legacy_c3_fallback EXIT')
  const isolated = normalize.indexOf('--mode isolate', trapInstalled)
  const recreated = normalize.indexOf('recreate-instances', isolated)
  const restored = normalize.indexOf('--mode restore', recreated)
  const c3Verified = normalize.indexOf('staging-gce-c3 general', restored)
  const restoreDisabled = normalize.indexOf('legacy_c3_isolated=false', c3Verified)
  const trapCleared = normalize.indexOf('trap - EXIT', restoreDisabled)
  assert.ok(
      trapInstalled < isolated &&
      isolated < recreated &&
      recreated < restored &&
      restored < c3Verified &&
      c3Verified < restoreDisabled &&
      restoreDisabled < trapCleared
  )
  assert.equal(normalize.indexOf('trap - EXIT', trapInstalled), trapCleared)
  assert.match(bootstrapWorkflow, /--heartbeat either/)
  assert.doesNotMatch(bootstrapWorkflow, /heartbeat=stale/)
  assert.match(
    rollCell,
    /"\$\{desired_cap\}" "\$\{desired_bound\}" absent-or-stale[\s\S]*?deploy-relay-blue-green\.mjs[\s\S]*?"\$\{desired_cap\}" "\$\{desired_bound\}"/
  )
})

test('workflows read desired topology from configuration and gate exact predecessors', () => {
  assert.match(workflow, /<<< 'local\.relay_director_cells_json' \| jq -r '\.'/)
  assert.match(bootstrapWorkflow, /<<< 'local\.relay_director_cells_json' \| jq -r '\.'/)
  assert.match(workflow, /1000\/0\)[\s\S]*?PREDECESSOR_C3_CAP=600/)
  assert.match(workflow, /1000\/60\)[\s\S]*?PREDECESSOR_C3_BOUND=0/)
  assert.match(workflow, /600\/60\)[\s\S]*?PREDECESSOR_C3_CAP=1000/)
  assert.match(workflow, /Unsupported staging capacity transition/)
})

test('capacity apply resumes after director or cell success and preserves the no-op restart proof', () => {
  for (const phase of ['predecessor', 'director-ready', 'cell-ready', 'cell-active']) {
    assert.match(workflow, new RegExp(`TRANSITION_PHASE=${phase}`))
  }
  assert.match(workflow, /--argjson expected "\$\{PREDECESSOR_CELLS_JSON\}"/)
  assert.match(workflow, /--argjson expected "\$\{DESIRED_CELLS_JSON\}"/)
  assert.match(
    workflow,
    /test "\$\{TRANSITION_PHASE\}" = cell-ready; then[\s\S]*?test "\$\{CELL_PLAN_CHANGES\}" = 0/
  )
  assert.match(
    workflow,
    /test "\$\{TRANSITION_PHASE\}" = cell-active; then[\s\S]*?recreate_fixed_one_instance/
  )
  assert.match(workflow, /--admission migration-only/)
})
