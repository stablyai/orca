import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { relayWorkflowUrl } from './relay-repository.mjs'

const workflow = readFileSync(
  relayWorkflowUrl('deploy-relay-asia-topology.yml'),
  'utf8'
)
const iam = readFileSync(
  new URL('../../infra/terraform/relay-asia-topology-iam.tf', import.meta.url),
  'utf8'
)
const cells = readFileSync(
  new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
  'utf8'
)
const variables = readFileSync(
  new URL('../../infra/terraform/variables.tf', import.meta.url),
  'utf8'
)

test('uses only its exact workflow-bound topology identity', () => {
  assert.match(workflow, /production-cloud-sql-rollout/)
  assert.match(workflow, /relay-staging-mutation/)
  assert.match(workflow, /RELAY_ASIA_TOPOLOGY_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(workflow, /RELAY_ASIA_TOPOLOGY_SERVICE_ACCOUNT/)
  assert.doesNotMatch(workflow, /GCP_DEPLOY_SERVICE_ACCOUNT/)
  assert.match(
    iam,
    /assertion\.workflow_ref == '\$\{prefix\}\$\{local\.github_relay_asia_topology_workflow_file\}@refs\/heads\/main'/
  )
  assert.match(iam, /assertion\.ref == 'refs\/heads\/main'/)
  assert.match(iam, /assertion\.event_name == 'workflow_dispatch'/)
  assert.match(iam, /assertion\.environment == '\$\{var\.environment\}'/)
})

test('plans only additive Asia topology and applies the saved plan', () => {
  assert.doesNotMatch(workflow, /manage_artifact_dns/)
  for (const target of [
    'relay_gce_additional',
    'google_compute_instance_template.relay_gce_cell',
    'google_compute_instance_group_manager.relay_gce_cell',
    'google_compute_backend_service.relay_gce_cell',
    'google_compute_url_map.relay_gce'
  ]) assert.match(workflow, new RegExp(target.replaceAll('.', '\\.')))
  assert.match(workflow, /apply -input=false -auto-approve "\$\{\{ steps\.plan\.outputs\.plan \}\}"/)
  assert.match(workflow, /prepare-relay-asia-topology-input\.mjs/)
  assert.doesNotMatch(workflow, /steps\.variables\.outputs\.file/)
  assert.match(workflow, /\.variables\.relay_gce_cells\.value/)
  assert.match(
    workflow,
    /\.variables\.relay_gce_additional_region_subnetwork_cidrs\.value/
  )
  assert.doesNotMatch(workflow, /terraform -chdir=infra\/terraform console/)
  assert.equal((workflow.match(/-var-file="\$\{TF_VARS\}"/g) ?? []).length, 2)
  assert.doesNotMatch(workflow, /terraform[^\n]*apply[^\n]*-target/)
  assert.doesNotMatch(workflow, /google_(?:sql|cloudflare|dns|certificate_manager)/)
})

test('validates before apply and proves convergence afterward', () => {
  assert.equal((workflow.match(/validate-relay-asia-topology-plan\.mjs/g) ?? []).length, 2)
  assert.match(workflow, /APPLY_RELAY_ASIA_TOPOLOGY/)
  assert.match(workflow, /test "\$\(jq -er '\.changes'/)
  assert.match(workflow, /Register the exact new cells atomically as migration-only/)
})

test('checks the connection budget and production live ceiling before planning', () => {
  assert.match(workflow, /relay-cloud-sql-connection-budget\.mjs/)
  assert.match(workflow, /gcloud sql instances describe "\$\{CLOUD_SQL_INSTANCE\}"/)
  assert.match(workflow, /select\(\.name == "max_connections"\)/)
  assert.match(workflow, /VERIFIED_DEFAULT_MAX_CONNECTIONS_TIER: db-custom-4-15360/)
  assert.match(workflow, /VERIFIED_DEFAULT_MAX_CONNECTIONS_DATABASE_VERSION: POSTGRES_17/)
  assert.match(workflow, /live_source=verified-shape-default/)
  assert.match(workflow, /test "\$\(jq -er '\.settings\.tier'/)
  assert.match(workflow, /test "\$\(jq -er '\.databaseVersion'/)
  assert.match(workflow, /test "\$\{live_max\}" = "\$\{checked_max\}"/)
  assert.ok(
    workflow.indexOf('relay-cloud-sql-connection-budget.mjs') <
      workflow.indexOf('terraform -chdir=infra/terraform plan')
  )
})

test('binds computed Asia references to the matching Terraform cell resources', () => {
  assert.match(cells, /instance_template = google_compute_instance_template\.relay_gce_cell\[each\.key\]\.self_link/)
  assert.match(cells, /group\s+= google_compute_instance_group_manager\.relay_gce_cell\[each\.key\]\.instance_group/)
  assert.match(cells, /default_service = google_compute_backend_service\.relay_gce_cell\[cell\.key\]\.id/)
  assert.match(cells, /subnetwork = local\.relay_gce_subnetworks\[each\.value\.region\]/)
})

test('keeps cross-variable region constraints in Terraform 1.5 check blocks', () => {
  assert.doesNotMatch(variables, /region != var\.region/)
  assert.doesNotMatch(variables, /cell\.region == var\.region/)
  assert.match(cells, /check "relay_gce_fixed_one_topology"[\s\S]*?region != var\.region/)
  assert.match(cells, /cell\.region == var\.region[\s\S]*?configured subnetwork/)
})

test('the custom role cannot delete topology or mutate SQL and DNS', () => {
  assert.doesNotMatch(iam, /compute\.[A-Za-z]+\.delete/)
  assert.doesNotMatch(
    iam,
    /roles\/viewer|cloudsql\.instances\.(?:update|delete)|dns\.|certificatemanager|cloudflare/i
  )
  assert.match(iam, /resource "google_project_iam_custom_role" "github_relay_asia_topology_read"/)
  assert.match(iam, /"cloudsql\.instances\.get"/)
  assert.match(iam, /"run\.revisions\.get"/)
  assert.match(iam, /"run\.services\.get"/)
  assert.match(iam, /"serviceusage\.services\.list"/)
  assert.match(iam, /"compute\.networks\.updatePolicy"/)
  assert.match(iam, /"compute\.healthChecks\.useReadOnly"/)
  assert.match(iam, /"compute\.instanceGroups\.create"/)
  assert.match(iam, /"compute\.instances\.use"/)
  assert.match(iam, /roles\/storage\.objectAdmin/)
  assert.match(iam, /default\.tfstate/)
  assert.match(iam, /default\.tflock/)
  assert.match(
    iam,
    /resource "google_project_iam_custom_role" "github_relay_asia_topology_state_list"[\s\S]*?permissions = \["storage\.objects\.list"\]/
  )
  assert.match(
    iam,
    /resource "google_storage_bucket_iam_member" "github_relay_asia_topology_state_list"[\s\S]*?role\s+= google_project_iam_custom_role\.github_relay_asia_topology_state_list\[0\]\.id/
  )
})
