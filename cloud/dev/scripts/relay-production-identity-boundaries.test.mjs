import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { readRelayWorkflow, relayWorkflowFile } from './relay-repository.mjs'
import { readWorkflow, workflowFiles } from './cloud-sql-rollout-lock-census.mjs'

async function source(path) {
  return await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

// Why: the shared deploy identity is relay-owned in production and moves with the relay
// extraction, so it needs a name the public repo can carry without touching the app pair. The
// generic names are retired; a workflow that still reads them would silently resolve to nothing.
test('no workflow names the retired generic production deploy identity', async () => {
  const files = workflowFiles()
  assert.ok(files.length > 20)
  const relayReaders = []
  for (const file of files) {
    const workflow = readWorkflow(file)
    assert.doesNotMatch(workflow, /PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER\b/, file)
    assert.doesNotMatch(workflow, /PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT\b/, file)
    if (/PRODUCTION_GCP_RELAY_DEPLOY_/.test(workflow)) relayReaders.push(file)
  }
  assert.deepEqual(relayReaders.sort(), [
    'deploy-relay-fence-broker.yml',
    'deploy-relay-production-capacity-job.yml',
    'deploy-relay-production-capacity.yml',
    'deploy-relay-production-director.yml',
    'deploy-relay-production-multi-target.yml',
    'deploy-relay-production-same-cap-job.yml',
    'deploy-relay-production-same-cap.yml',
    'deploy-relay-production.yml',
    'operate-relay-asia-admission.yml',
    'operate-relay-production-rehome-job.yml',
    'publish-relay-production.yml'
  ].map((name) => relayWorkflowFile(name)).sort())
})

test('monitor workflow has no shared deploy identity fallback', async () => {
  const workflow = readRelayWorkflow('monitor-relay-production-job.yml')
  assert.match(workflow, /PRODUCTION_GCP_RELAY_MONITOR_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(workflow, /PRODUCTION_GCP_RELAY_MONITOR_SERVICE_ACCOUNT/)
  assert.doesNotMatch(workflow, /PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT/)
  assert.doesNotMatch(workflow, /PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER/)
})

test('relay fencing uses the dedicated requester and private broker', async () => {
  const workflow = readRelayWorkflow('deploy-relay-production-multi-target.yml')
  assert.match(workflow, /Reject direct-runner Terraform fence aborts/)
  assert.match(workflow, /inputs\.mode == 'fence-source'/)
  assert.match(workflow, /inputs\.mode == 'abort-fence-source'/)
  assert.match(workflow, /inputs\.mode == 'supersede-target'/)
  assert.match(workflow, /PRODUCTION_GCP_RELAY_FENCE_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(workflow, /PRODUCTION_GCP_RELAY_FENCE_SERVICE_ACCOUNT/)
  assert.match(workflow, /PRODUCTION_GCP_RELAY_FENCE_BROKER_URI/)
  assert.match(workflow, /Invoke private target-supersession broker/)
  assert.match(workflow, /Invoke private source-fence broker/)
  assert.match(workflow, /Require exact broker cell contract/)
  assert.match(workflow, /Require exact source-fence broker contract/)
  assert.match(workflow, /Require private fence-broker environment/)
  assert.match(
    workflow,
    /DEPLOY_MODE\}" = "execute" \|\|\s+"\$\{DEPLOY_MODE\}" = "recover-forward"\) &&\s+"\$\{SOURCE_CELL_ID\}" = "production-gce-c12"/
  )
  assert.match(
    workflow,
    /--scoped-recovery-source-cell-id\s+production-gce-c3/
  )
  assert.match(
    workflow,
    /test "\$\{FAILED_TARGET_CELL_ID\}" = "production-gce-c12"/
  )
  assert.match(
    workflow,
    /test "\$\{REPLACEMENT_TARGET_CELL_ID\}" = "production-gce-c13"/
  )
  assert.match(
    workflow,
    /test "\$\{TARGET_CELL_IDS\}" = "production-gce-c12,production-gce-c13"/
  )
  assert.match(
    workflow,
    /test "\$\{TARGET_CELL_IDS\}" = "production-gce-c7,production-gce-c8,production-gce-c10,production-gce-c13,production-gce-c17,production-gce-c18"/
  )
  const jobGate = workflow.slice(
    workflow.indexOf('jobs:'),
    workflow.indexOf('runs-on:')
  )
  assert.doesNotMatch(jobGate, /PRODUCTION_GCP_RELAY_FENCE_/)
  const brokerStep = workflow.slice(
    workflow.indexOf('- name: Invoke private target-supersession broker'),
    workflow.indexOf('- name: Preflight or run multi-target evacuation')
  )
  assert.match(brokerStep, /steps\.google-fence-broker-auth\.outputs\.id_token/)
  assert.doesNotMatch(brokerStep, /PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT/)
  const sourceFenceStep = workflow.slice(
    workflow.indexOf('- name: Invoke private source-fence broker'),
    workflow.indexOf('- name: Preflight or run multi-target evacuation')
  )
  assert.match(sourceFenceStep, /steps\.google-fence-broker-auth\.outputs\.id_token/)
  assert.match(sourceFenceStep, /\/v1\/fence-source/)
  assert.doesNotMatch(sourceFenceStep, /PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT/)
})

test('Terraform binds dedicated identities to exact OIDC and resource boundaries', async () => {
  const terraform = await source('infra/terraform/relay-github-actions.tf')
  for (const claim of ['job_workflow_ref', 'workflow_ref', 'ref', 'environment']) {
    assert.match(terraform, new RegExp(`assertion\\.${claim}`))
  }
  assert.match(terraform, /github_monitor_workflow_file/)
  assert.match(terraform, /github_fence_workflow_file/)
  assert.match(terraform, /github_production_relay_capacity_job_workflow_file/)
  assert.match(terraform, /google_service_account" "github_monitor"/)
  assert.match(terraform, /google_service_account" "github_fence"/)
  assert.match(terraform, /google_service_account\.github_monitor\[0\]\.member/)
  assert.match(terraform, /service_account_id = google_service_account\.github_fence\[0\]\.name/)
  assert.match(terraform, /attribute\.relay_ops_identity\/monitor/)
  assert.match(terraform, /attribute\.relay_ops_identity\/fence/)
  assert.doesNotMatch(terraform, /github_relay_fence_operator/)
  assert.doesNotMatch(terraform, /github_terraform_fence_state_writer/)
  const broker = await source('infra/terraform/relay-fence-broker.tf')
  assert.match(broker, /max_instance_request_concurrency = 1/)
  assert.match(broker, /max_instance_count = 1/)
  assert.match(broker, /roles\/run\.invoker/)
  assert.match(broker, /google_service_account\.github_fence\[0\]\.member/)
  assert.doesNotMatch(broker, /allUsers/)
  const brokerDeploy = readRelayWorkflow('deploy-relay-fence-broker.yml')
  assert.match(brokerDeploy, /sha-\$\{GITHUB_SHA\}/)
  assert.match(brokerDeploy, /gcloud run services update/)
  assert.match(brokerDeploy, /\.status\.traffic/)
  assert.doesNotMatch(brokerDeploy, /latestReadyRevisionName/)
  assert.doesNotMatch(brokerDeploy, /--set-env-vars/)
})

test('Terraform exposes the audited production environment values', async () => {
  const outputs = await source('infra/terraform/outputs.tf')
  for (const output of [
    'github_relay_monitor_workload_identity_provider',
    'github_relay_monitor_service_account',
    'github_relay_fence_workload_identity_provider',
    'github_relay_fence_service_account'
  ]) {
    assert.match(outputs, new RegExp(`output "${output}"`))
  }
})

test('production mutations pass the minted admin token to live preflight', async () => {
  const workflow = readRelayWorkflow('deploy-relay-production.yml')
  const recheck = workflow.slice(
    workflow.indexOf('- name: Recheck all live safety signals'),
    workflow.indexOf('- name: Create single-use dry-run marker')
  )
  assert.match(
    recheck,
    /ORCA_RELAY_ADMIN_ID_TOKEN: \$\{\{ steps\.google-auth\.outputs\.id_token \}\}/
  )
  const multiTarget = readRelayWorkflow('deploy-relay-production-multi-target.yml')
  const multiTargetRecheck = multiTarget.slice(
    multiTarget.indexOf('- name: Recheck all live safety signals'),
    multiTarget.indexOf('- name: Create single-use dry-run marker')
  )
  assert.match(multiTargetRecheck, /steps\.google-auth\.outputs\.id_token/)
  assert.match(multiTargetRecheck, /inputs\.mode != 'supersede-target'/)
})

test('fence broker pins the production-proven Terraform planner', async () => {
  const dockerfile = await source('apps/relay-fence-broker/Dockerfile')
  assert.match(dockerfile, /FROM hashicorp\/terraform:1\.15\.8 AS terraform/)
})
