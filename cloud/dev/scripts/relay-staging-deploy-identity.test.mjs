import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readWorkflow, workflowFiles } from './cloud-sql-rollout-lock-census.mjs'
import {
  RELAY_WORKFLOW_FILE_PREFIX,
  relayWorkflowFile,
  relayWorkflowPath
} from './relay-repository.mjs'

const identity = readFileSync(
  new URL('../../infra/terraform/relay-staging-deploy-iam.tf', import.meta.url),
  'utf8'
)
const shared = readFileSync(
  new URL('../../infra/terraform/relay-shared.tf', import.meta.url),
  'utf8'
)
const variables = readFileSync(
  new URL('../../infra/terraform/variables.tf', import.meta.url),
  'utf8'
)
const outputs = readFileSync(new URL('../../infra/terraform/outputs.tf', import.meta.url), 'utf8')
const stagingTfvars = readFileSync(
  new URL('../../infra/terraform/environments/staging.tfvars', import.meta.url),
  'utf8'
)

// The exact five staging Relay workflows the relay-owned deploy identity serves.
const DEPLOY_WORKFLOWS = [
  'bootstrap-relay-staging-capacity.yml',
  'deploy-relay-staging-gce-candidate.yml',
  'deploy-relay-staging.yml',
  'operate-relay-asia-admission.yml',
  'power-relay-staging.yml'
]

const GENERIC_STAGING_PAIR =
  /vars\.STAGING_GCP_(?:WORKLOAD_IDENTITY_PROVIDER|DEPLOY_SERVICE_ACCOUNT)\b/

const workflowNames = workflowFiles
// DEPLOY_WORKFLOWS holds the names Terraform pins; the files on disk carry the copy's prefix.
const workflow = (name) => readWorkflow(relayWorkflowFile(name))

function block(type, name) {
  const start = identity.indexOf(`resource "${type}" "${name}"`)
  assert.notEqual(start, -1, `${type}.${name} is missing`)
  const next = identity.indexOf('\nresource "', start + 1)
  return identity.slice(start, next === -1 ? undefined : next)
}

function declaredFamilies() {
  return [...identity.matchAll(/^resource "([a-z0-9_]+)" "([a-z0-9_]+)"/gm)]
    .map((match) => `${match[1]}.${match[2]}`)
    .sort()
}

function providerWorkflowFiles() {
  const match = identity.match(
    /github_staging_relay_deploy_workflow_files\s*=\s*\[([\s\S]*?)\n {2}\]/
  )
  assert.ok(match, 'github_staging_relay_deploy_workflow_files is missing')
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
}

function variableDefault(name) {
  const match = variables.match(
    new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*"([^"]*)"`)
  )
  assert.ok(match, `variable ${name} has no default`)
  return match[1]
}

test('no Relay workflow authenticates as the shared staging deploy identity', () => {
  for (const name of workflowNames()) {
    if (!name.includes('relay')) continue
    assert.doesNotMatch(readWorkflow(name), GENERIC_STAGING_PAIR, name)
  }
})

test('the five staging Relay workflows name the relay deploy pair', () => {
  for (const name of DEPLOY_WORKFLOWS) {
    const source = workflow(name)
    assert.match(source, /vars\.STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER\b/, name)
    assert.match(source, /vars\.STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT\b/, name)
  }
})

// Why: the Asia workflow serves both environments from one job. Repointing its staging arm must
// not move production off the relay-owned shared account.
test('the Asia admission production arm keeps the production deploy pair', () => {
  const source = workflow('operate-relay-asia-admission.yml')
  assert.match(source, /vars\.PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER\b/)
  assert.match(source, /vars\.PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT\b/)
})

test('the provider allowlists exactly those five workflow refs', () => {
  const files = providerWorkflowFiles()
  assert.deepEqual([...files].sort(), [...DEPLOY_WORKFLOWS].sort())
  for (const file of files) {
    assert.match(file, /^[a-z0-9-]+\.yml$/)
  }
  // Each accepted repository turns that file list into its own exact refs.
  assert.match(
    identity,
    /for workflow_file in local\.github_staging_relay_deploy_workflow_files : "assertion\.workflow_ref == '\$\{prefix\}\$\{workflow_file\}@refs\/heads\/main'"/
  )

  const provider = block(
    'google_iam_workload_identity_pool_provider',
    'github_staging_relay_deploy'
  )
  assert.match(provider, /workload_identity_pool_provider_id\s*=\s*"github-relay-deploy"/)
  assert.match(provider, /concat\(local\.relay_github_leading_repository_claims/)
  assert.match(provider, /assertion\.ref == 'refs\/heads\/main'/)
  assert.match(provider, /assertion\.environment == 'staging'/)
  assert.match(provider, /local\.relay_github_workflow_conditions\["github_staging_relay_deploy"\]/)
  // A prefix match would turn the allowlist into a namespace grant with no Terraform diff.
  assert.doesNotMatch(provider, /startsWith|endsWith/)
})

// Why: the documented attribute_condition limit is 4096 characters and the expression grows with
// every workflow added. Render it the way Terraform does and keep the headroom visible.
test('the rendered attribute condition stays inside the provider limit', () => {
  const repository = `${variableDefault('github_owner')}/${variableDefault('github_repo')}`
  const claims = [
    `assertion.repository == '${repository}'`,
    `assertion.repository_id == '${variableDefault('github_repo_id')}'`,
    `assertion.repository_owner_id == '${variableDefault('github_owner_id')}'`
  ]
  const workflowRefs = providerWorkflowFiles().map(
    (file) => `${repository}/${relayWorkflowPath(file)}@refs/heads/main`
  )
  const rendered = [
    ...claims,
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == 'staging'",
    `(${workflowRefs.map((ref) => `assertion.workflow_ref == '${ref}'`).join(' || ')})`
  ].join(' && ')
  assert.ok(rendered.length < 4096, `rendered condition is ${rendered.length} characters`)
  // 797 is the private repository's rendered length. This copy prefixes every workflow filename,
  // which is the only difference, so the pin still moves the moment a workflow is added or dropped.
  assert.equal(rendered.length, 797 + workflowRefs.length * RELAY_WORKFLOW_FILE_PREFIX.length)
})

// Why: the census is the point. A binding added here without a workflow step behind it, or one
// silently dropped, changes what the staging Relay credential can reach.
test('the staging deploy identity declares exactly its enumerated grants', () => {
  assert.deepEqual(declaredFamilies(), [
    'google_artifact_registry_repository_iam_member.github_staging_relay_deploy_artifact_reader',
    'google_cloud_run_v2_service_iam_member.github_staging_relay_deploy_auth_developer',
    'google_cloud_run_v2_service_iam_member.github_staging_relay_deploy_director_developer',
    'google_iam_workload_identity_pool_provider.github_staging_relay_deploy',
    'google_project_iam_member.github_staging_relay_deploy_compute_viewer',
    'google_service_account.github_staging_relay_deploy',
    'google_service_account_iam_member.github_staging_relay_deploy_auth_runtime_user',
    'google_service_account_iam_member.github_staging_relay_deploy_workload_identity_user',
    'google_storage_bucket_iam_member.github_staging_relay_deploy_state',
    'google_storage_bucket_iam_member.github_staging_relay_deploy_state_list'
  ])
  // Each grant carries a comment naming the workflow step that needs it; the account, its
  // provider, and the pool binding are the identity itself and are covered by the file header.
  const identityFamilies = new Set([
    'google_service_account.github_staging_relay_deploy',
    'google_iam_workload_identity_pool_provider.github_staging_relay_deploy',
    'google_service_account_iam_member.github_staging_relay_deploy_workload_identity_user'
  ])
  for (const family of declaredFamilies()) {
    if (identityFamilies.has(family)) continue
    const [type, name] = family.split('.')
    const preceding = identity.slice(0, identity.indexOf(`resource "${type}" "${name}"`)).trimEnd()
    assert.match(preceding.slice(preceding.lastIndexOf('\n') + 1), /^#/, `${family} has no justifying comment`)
  }
  assert.match(identity, /var\.environment == "staging"/)

  const state = block('google_storage_bucket_iam_member', 'github_staging_relay_deploy_state')
  assert.match(state, /roles\/storage\.objectViewer/)
  assert.match(state, /objects\/terraform\/state\/default\.tfstate/)
  assert.match(state, /objects\/terraform\/state\/default\.tflock/)
  assert.doesNotMatch(state, /resource\.name\.startsWith/)
  assert.doesNotMatch(state, /objectAdmin/)

  const director = block(
    'google_cloud_run_v2_service_iam_member',
    'github_staging_relay_deploy_director_developer'
  )
  assert.match(director, /name\s*=\s*var\.relay_cloud_run_service_name/)

  // Project-wide run.developer or artifactregistry.writer would let the staging Relay credential
  // deploy the API service or push images; the shared account holds both today.
  const projectRoles = declaredFamilies()
    .filter((family) => family.startsWith('google_project_iam_member.'))
    .map((family) => block('google_project_iam_member', family.split('.')[1]).match(/role\s*=\s*"([^"]+)"/)[1])
  assert.deepEqual(projectRoles, ['roles/compute.viewer'])
  assert.doesNotMatch(identity, /roles\/artifactregistry\.writer/)
  assert.doesNotMatch(identity, /"roles\/(?:owner|editor|viewer)"/)
})

// Why: the auth-plane grants are guarded on a variable, so an unset tfvars entry would drop them
// silently and Power Relay Staging would fail only on the sleep path.
test('staging pins the shared auth service the power workflow scales', () => {
  assert.match(stagingTfvars, /relay_staging_power_auth_service_name\s*=\s*"orca-cloud-auth-staging"/)
  assert.match(variables, /variable "relay_staging_power_auth_service_name"/)
  for (const name of [
    'github_staging_relay_deploy_auth_developer',
    'github_staging_relay_deploy_auth_runtime_user'
  ]) {
    const type = name.endsWith('runtime_user')
      ? 'google_service_account_iam_member'
      : 'google_cloud_run_v2_service_iam_member'
    assert.match(block(type, name), /var\.relay_staging_power_auth_service_name != ""/)
  }
})

// Why: flipping this local is what moves the staging cells' startup metadata and the director's
// ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT onto the new account. Production must keep the shared one.
test('the deploy account email is environment-conditional', () => {
  assert.match(
    shared,
    /relay_github_deploy_service_account_email = \(\s*var\.environment == "production"\s*\? "\$\{var\.name_prefix\}-gha-deploy@\$\{var\.project_id\}\.iam\.gserviceaccount\.com"\s*: "\$\{var\.name_prefix\}-gha-relay@\$\{var\.project_id\}\.iam\.gserviceaccount\.com"\s*\)/
  )
  assert.match(identity, /account_id\s*=\s*"\$\{var\.name_prefix\}-gha-relay"/)
})

test('the identity is exposed through its own outputs', () => {
  assert.match(outputs, /output "github_staging_relay_deploy_workload_identity_provider"/)
  assert.match(outputs, /output "github_staging_relay_deploy_service_account"/)
})
