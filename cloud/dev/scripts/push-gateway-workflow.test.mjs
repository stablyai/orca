import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  concurrencyBlocks,
  jobIf,
  jobs,
  LEASE_ACTION,
  leaseSteps
} from './cloud-sql-rollout-lock-census.mjs'
import { readRelayWorkflow, relayWorkflowFile } from './relay-repository.mjs'

// Why: the push gateway holds the APNs key and is the only thing standing between a paired
// phone and a silent notification pipeline. Its deploy is a blue/green rollout against the
// dedicated Cloud SQL instance, and each of the guarantees below is one careless edit from gone.
const WORKFLOW = 'push-deploy.yml'
const workflow = readRelayWorkflow(WORKFLOW)
const deploy = () => {
  const job = jobs(workflow).find((entry) => entry.id === 'deploy')
  assert.ok(job, 'the workflow no longer declares a deploy job')
  return job
}

function terraform(file) {
  return readFileSync(new URL(`../../infra/terraform/${file}`, import.meta.url), 'utf8')
}

// The ordered step names; every assertion below reads positions out of this list rather than
// restating them, so a reordering that breaks the no-traffic guarantee fails here.
const stepNames = () => [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1])

const indexOfStep = (name) => {
  const index = stepNames().indexOf(name)
  assert.notEqual(index, -1, `the workflow no longer has a "${name}" step`)
  return index
}

test('the whole surface stays inert until the owner enables cloud operations', () => {
  const guard = jobIf(deploy().text)
  assert.ok(guard.includes("vars.ORCA_CLOUD_OPERATIONS_ENABLED == 'true'"), guard)
  assert.ok(guard.includes("github.ref == 'refs/heads/main'"), guard)
  assert.equal(jobs(workflow).length, 1, 'a second job would need its own gate')
})

test('it authenticates through Workload Identity and holds no repository secret', () => {
  assert.match(workflow, /uses: google-github-actions\/auth@v2/)
  assert.match(workflow, /workload_identity_provider: \$\{\{ vars\.PRODUCTION_GCP_PUSH_DEPLOY_WORKLOAD_IDENTITY_PROVIDER \}\}/)
  assert.match(workflow, /service_account: \$\{\{ vars\.PRODUCTION_GCP_PUSH_DEPLOY_SERVICE_ACCOUNT \}\}/)
  assert.match(workflow, /environment: production/)
  for (const [, name] of workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assert.equal(name, 'GITHUB_TOKEN', `the workflow reads secrets.${name}`)
  }
})

// Why: Terraform trusts exact workflow filenames, not a prefix. A rename here without the
// matching tfvars-independent list entry would fail authentication at dispatch time only.
test('Terraform trusts this exact workflow file on the production deploy provider', () => {
  assert.match(terraform('push-deploy-identity.tf'), /push-deploy\.yml@refs\/heads\/main/)
  assert.doesNotMatch(terraform('relay-github-actions.tf'), /push-deploy\.yml/)
  assert.equal(relayWorkflowFile(WORKFLOW), 'cloud-push-deploy.yml')
})

test('the rollout is serialized and leases its dedicated push rollout lock', () => {
  const blocks = concurrencyBlocks(workflow)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].group, 'production-push-rollout')
  assert.equal(blocks[0].cancelInProgress, 'false')
  const steps = leaseSteps(workflow)
  assert.equal(steps.length, 1, 'exactly one lease step, held for the whole run')
  assert.equal(steps[0].bucket, 'onorca-cloud-terraform-state')
  assert.equal(steps[0].object, 'terraform/state/push-rollout/production.lock')
  assert.equal(steps[0].release, undefined, 'release stays at its default for a single-job run')
})

// Why: the ops guardrail is that a piped command only fails the step when pipefail is set, and
// pipefail only applies under an explicit bash shell. Every multi-line body here opts in.
test('every multi-line command runs under bash with pipefail', () => {
  const bodies = [...workflow.matchAll(/^ {8}(shell: bash\n {8})?run: \|\n((?: {10}.*\n|\n)+)/gm)]
  assert.ok(bodies.length >= 8, `only ${bodies.length} multi-line commands were found`)
  for (const match of bodies) {
    assert.ok(match[1], `a multi-line command does not declare shell: bash:\n${match[2].slice(0, 120)}`)
    assert.match(match[2], /^ {10}set -euo pipefail$/m)
  }
})

test('the candidate revision takes no traffic and is addressed by its own tag', () => {
  assert.match(workflow, /gcloud run deploy "\$\{SERVICE_NAME\}"/)
  assert.match(workflow, /^ {12}--no-traffic \\$/m)
  assert.match(workflow, /--tag "\$\{tag\}"/)
  assert.match(workflow, /test "\$\{CANDIDATE_REVISION\}" != "\$\{ROLLBACK_REVISION\}"/)
  assert.ok(
    indexOfStep('Record the serving revision and require its Terraform-owned scaling') <
      indexOfStep('Deploy the candidate revision with no traffic'),
    'the rollback target must be captured before the candidate exists'
  )
})

// Why: scaling is a Terraform-owned field that `lifecycle.ignore_changes` does not cover, so a
// deploy that passed --max-instances would revert a later push_max_instances raise on every run.
// The workflow asserts the shape instead of writing it, on the serving revision before the
// candidate exists and on the candidate that inherits it.
test('the deploy asserts the Terraform-owned scaling instead of mutating it', () => {
  assert.doesNotMatch(workflow, /--max-instances/, 'the deploy must not write a scaling field')
  assert.doesNotMatch(workflow, /--min-instances "/, 'the deploy must not write a scaling field')
  // The floor is the variables.tf default; production.tfvars overrides only the ceiling, down to
  // the two instances the Cloud SQL connection budget leaves room for.
  assert.match(workflow, /PUSH_MIN_INSTANCES: 1$/m)
  assert.match(workflow, /PUSH_MAX_INSTANCES: 2$/m)
  assert.match(terraform('variables.tf'), /variable "push_min_instances"[\s\S]*?default {5}= 1/)
  assert.match(terraform('environments/production.tfvars'), /^push_max_instances {9}= 2$/m)
  const gate = indexOfStep('Record the serving revision and require its Terraform-owned scaling')
  assert.ok(gate < indexOfStep('Deploy the candidate revision with no traffic'))
  assert.match(workflow, /autoscaling\.knative\.dev\/minScale/)
  assert.match(workflow, /\[\[ "\$\{floor:-0\}" -lt "\$\{PUSH_MIN_INSTANCES\}" \]\]/)
  assert.match(workflow, /test "\$\{ceiling\}" = "\$\{PUSH_MAX_INSTANCES\}"/)
  assert.match(workflow, /test "\$\{candidate_ceiling\}" = "\$\{PUSH_MAX_INSTANCES\}"/)
})

// Why: the image build is not a Cloud SQL operation, and the lease is a global serialization
// point. A build inside it blocks every relay deploy and rehome for its duration.
test('the image is built before the rollout lease is taken', () => {
  const lease = workflow.indexOf(`- uses: ${LEASE_ACTION}`)
  assert.notEqual(lease, -1)
  const build = workflow.indexOf('- name: Build and publish the immutable gateway image')
  const deployCandidate = workflow.indexOf('- name: Deploy the candidate revision with no traffic')
  assert.ok(build < lease, 'the build must finish before the run takes the lease')
  assert.ok(lease < deployCandidate, 'the lease must still cover the deploy, probe, and shift')
})

// Why: the gateway's Cloud SQL draw is instances x pool, and the root that takes the rollout
// lease can only account for a pool it declares. Leaving it at the application default hid it.
test('the database pool size is Terraform-owned and bounded at plan time', () => {
  const source = terraform('push-gateway.tf')
  assert.match(source, /name {2}= "ORCA_PUSH_DATABASE_POOL_MAX"/)
  assert.match(source, /value = tostring\(var\.push_database_pool_max\)/)
  assert.match(terraform('variables.tf'), /variable "push_database_pool_max"[\s\S]*?default {5}= 2/)
  const block = /resource "google_cloud_run_v2_service" "push"[\s\S]*?\n  lifecycle \{([\s\S]*?)\n  \}/.exec(source)
  assert.ok(block, 'the push service no longer declares a lifecycle block')
  assert.match(
    block[1],
    /var\.push_max_instances \* var\.push_database_pool_max \* 3 <= 64/,
    'instances x pool must be bounded at plan time'
  )
  assert.match(
    readFileSync(new URL('../../apps/push/src/config.ts', import.meta.url), 'utf8'),
    /ORCA_PUSH_DATABASE_POOL_MAX/,
    'the gateway must read the variable Terraform sets'
  )
})

test('the candidate is probed on its own URL before any traffic moves', () => {
  const probe = indexOfStep('Probe the candidate readiness endpoint')
  assert.ok(probe > indexOfStep('Deploy the candidate revision with no traffic'))
  assert.ok(probe < indexOfStep('Shift all traffic to the verified candidate'))
  assert.match(workflow, /"\$\{CANDIDATE_URL\}\/ready"/)
  assert.match(workflow, /test "\$\{code\}" = 200/)
  assert.ok(workflow.indexOf('${CANDIDATE_URL}/ready') < workflow.indexOf('${CANDIDATE_URL}/health'))
  assert.match(workflow, /\.deliveryProtocol == 2/, 'verify the durable gateway after readiness')
})

// Why: a gateway that answers /ready can still hold no usable FCM credential. The probe must be
// validate-only, must use a token that cannot exist, and must treat a denied credential as the
// failure. Accepting PERMISSION_DENIED would make the whole step decorative.
test('the FCM probe is validate-only and separates a bad token from a bad credential', () => {
  const fcm = indexOfStep('Prove the runtime identity can reach FCM')
  assert.ok(fcm > indexOfStep('Probe the candidate readiness endpoint'))
  assert.ok(fcm < indexOfStep('Shift all traffic to the verified candidate'))
  assert.match(workflow, /"validate_only":true/)
  assert.match(workflow, /https:\/\/fcm\.googleapis\.com\/v1\/projects\/\$\{GCP_PROJECT_ID\}\/messages:send/)
  assert.match(workflow, /GCP_PROJECT_ID: onorca-cloud$/m)
  assert.match(workflow, /orca-push-deploy-probe-invalid-token/)
  assert.match(workflow, /test "\$\{status\}" = INVALID_ARGUMENT/)
  assert.match(workflow, /test "\$\{status\}" = PERMISSION_DENIED/)
  // Only those four answers are conclusive; a 429 or a 5xx says nothing about the credential, so
  // it is retried rather than read as either verdict. A denied credential still fails at once.
  assert.match(workflow, /for attempt in \$\(seq 1 5\); do/)
  const probe = workflow.slice(
    workflow.indexOf('- name: Prove the runtime identity can reach FCM'),
    workflow.indexOf('- name: Shift all traffic to the verified candidate')
  )
  assert.match(probe, /for attempt in \$\(seq 1 5\); do/)
  assert.match(probe, /test "\$\{code\}" = 401 \|\| test "\$\{code\}" = 403; then\n {14}break/)
  assert.match(
    workflow,
    /--impersonate-service-account "\$\{PUSH_RUNTIME_SERVICE_ACCOUNT\}"/,
    'the probe must exercise the runtime credential, not the deploy identity'
  )
  // Why: that token reads the Apple signing key. Masking it means a later `set -x` or a
  // debug re-run cannot print it into a public log.
  assert.match(
    probe,
    /test -n "\$\{token\}"\n {10}echo "::add-mask::\$\{token\}"/,
    'the impersonated token must be masked before anything else runs'
  )
  assert.match(workflow, /PUSH_RUNTIME_SERVICE_ACCOUNT: orca-cloud-push@onorca-cloud\.iam\.gserviceaccount\.com/)
})

// Why: a deploy ends with traffic pinned to an exact revision, and a rollback pins it to the
// previous one. Terraform reverting the service to 100% LATEST would undo either silently.
test('Terraform does not own the image or the traffic split', () => {
  const source = terraform('push-gateway.tf')
  const block = /resource "google_cloud_run_v2_service" "push"[\s\S]*?\n  lifecycle \{([\s\S]*?)\n  \}/.exec(source)
  assert.ok(block, 'the push service no longer declares a lifecycle block')
  assert.match(block[1], /template\[0\]\.containers\[0\]\.image/)
  assert.match(block[1], /^\s*traffic$/m)
})

test('impersonating the runtime identity is a Terraform-declared grant', () => {
  const source = terraform('push-gateway.tf')
  assert.match(source, /resource "google_service_account_iam_member" "github_production_push_runtime_token_creator"/)
  assert.match(source, /role\s+= "roles\/iam\.serviceAccountTokenCreator"/)
  assert.match(source, /resource "google_cloud_run_v2_service_iam_member" "github_production_push_developer"/)
})

test('the traffic shift is all-or-nothing and is verified after the fact', () => {
  const shift = indexOfStep('Shift all traffic to the verified candidate')
  assert.match(workflow, /gcloud run services update-traffic "\$\{SERVICE_NAME\}"/)
  assert.match(workflow, /--to-revisions "\$\{CANDIDATE_REVISION\}=100"/)
  assert.match(workflow, /test "\$\{serving\}" = "\$\{CANDIDATE_REVISION\}"/)
  assert.ok(shift < indexOfStep('Verify the public origin after the shift'))
  assert.match(workflow, /PUSH_ORIGIN: https:\/\/push\.onorca\.dev/)
  assert.match(workflow, /"\$\{PUSH_ORIGIN\}\/ready"/)
})

// Why: the origin can lag the traffic move by seconds, and a single unlucky curl would otherwise
// roll a healthy deploy back. It retries on the same schedule as the candidate probe.
test('the post-shift origin check retries like the candidate probe', () => {
  const check = workflow.slice(
    workflow.indexOf('- name: Verify the public origin after the shift'),
    workflow.indexOf('- name: Roll traffic back to the previous revision')
  )
  assert.match(check, /for attempt in \$\(seq 1 30\); do/)
  assert.match(check, /sleep 5/)
  assert.match(check, /test "\$\{code\}" = 200/)
})

// Why: the summary carries the rollback target. Writing it after the origin check meant the one
// run that needed it, the run whose check failed, was the one run that never got it.
test('the summary is written before anything that can fail after the shift', () => {
  const summary = indexOfStep('Publish the rollout summary')
  assert.ok(summary > indexOfStep('Shift all traffic to the verified candidate'))
  assert.ok(summary < indexOfStep('Verify the public origin after the shift'))
  assert.match(workflow, /Known-good image:/)
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
})

// Why: everything after the shift runs with production on the candidate, so a failure there is a
// live gateway that has to go back. The marker is what separates that case from a failure before
// the shift, where production never moved and the candidate is the thing to clean up.
test('a failure after the shift rolls production back automatically', () => {
  const rollback = indexOfStep('Roll traffic back to the previous revision')
  assert.ok(rollback > indexOfStep('Verify the public origin after the shift'))
  assert.match(workflow, /echo "TRAFFIC_SHIFTED=true" >> "\$\{GITHUB_ENV\}"/)
  const shift = workflow.indexOf('- name: Shift all traffic to the verified candidate')
  assert.ok(
    workflow.indexOf('echo "TRAFFIC_SHIFTED=true"') > shift,
    'the success marker follows the shift step'
  )
  const body = workflow.slice(
    workflow.indexOf('- name: Roll traffic back to the previous revision'),
    workflow.indexOf('- name: Delete the rejected candidate revision')
  )
  assert.match(
    body,
    /if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && env\.TRAFFIC_SHIFT_ATTEMPTED == 'true' && env\.ROLLOUT_VERIFIED != 'true' \}\}/,
    'the rollback must be conditioned on both failure and the shift marker'
  )
  assert.match(body, /test -n "\$\{ROLLBACK_REVISION:-\}"/)
  assert.match(body, /--to-revisions "\$\{ROLLBACK_REVISION\}=100"/)
  assert.match(body, /test "\$\{serving\}" = "\$\{ROLLBACK_REVISION\}"/)
  assert.match(body, /GITHUB_STEP_SUMMARY/, 'the rollback must be reported in the summary')
})

// Why: a candidate that never took traffic still holds a warm instance and a Cloud SQL pool. Its
// tag comes off first, because Cloud Run refuses to delete a revision a traffic target names.
test('verified recovery authorizes rejected candidate deletion', () => {
  const body = workflow.slice(
    workflow.indexOf('- name: Delete the rejected candidate revision'),
    workflow.indexOf('- name: Drop the candidate traffic tag')
  )
  assert.match(
    body,
    /env\.RECOVERY_VERIFIED == 'true'/,
    'cleanup must wait for verified recovery traffic and public checks'
  )
  assert.match(body, /if test -z "\$\{CANDIDATE_REVISION:-\}"; then/)
  assert.ok(
    body.indexOf('--remove-tags') < body.indexOf('gcloud run revisions delete'),
    'the tag must come off before the revision is deleted'
  )
  assert.match(body, /echo "CANDIDATE_TAG=" >> "\$\{GITHUB_ENV\}"/)
})

test('the run always drops its traffic tag', () => {
  const cleanup = indexOfStep('Drop the candidate traffic tag')
  assert.equal(cleanup, stepNames().length - 1, 'tag cleanup must be the last step')
  assert.match(workflow, /--remove-tags "\$\{CANDIDATE_TAG\}"/)
  const body = workflow.slice(workflow.indexOf('- name: Drop the candidate traffic tag'))
  assert.match(body, /if: always\(\)/)
  assert.match(body, /test -n "\$\{CANDIDATE_TAG:-\}" \|\| exit 0/)
})

test('push credentials cannot assume the shared Relay deploy identity', () => {
  const source = terraform('push-deploy-identity.tf')
  assert.match(source, /"attribute.push_deploy"\s*=\s*"'production'"/)
  assert.doesNotMatch(source, /"attribute.repository"\s*=/)
  assert.match(source, /attribute\.push_deploy\/production/)
  assert.doesNotMatch(workflow, /PRODUCTION_GCP_RELAY_DEPLOY_/)
  assert.doesNotMatch(terraform('push-gateway.tf'), /member\s*=\s*local\.relay_github_deploy_service_account_member/)
})

// A latest revision needs a successor even when validation is inert.
test('dedicated database admits three simultaneous revision pools', () => {
  assert.match(terraform('push-gateway.tf'), /var\.push_max_instances \* var\.push_database_pool_max \* 3 <= 64/)
})

test('push has only a dedicated database attachment and a narrowly scoped deployment lease', () => {
  const service = terraform('push-gateway.tf')
  const database = terraform('push-dedicated-database.tf')
  assert.match(service, /instances = \[google_sql_database_instance\.push_dedicated\[0\]\.connection_name\]/)
  assert.match(service, /secret\s*= google_secret_manager_secret\.push_dedicated_database_url\[0\]\.secret_id/)
  assert.match(service, /version = google_secret_manager_secret_version\.push_dedicated_database_url\[0\]\.version/)
  assert.doesNotMatch(service + database, /push_dedicated_database_(?:active|enabled)|local\.relay_database_connection_name|resource "google_sql_database" "push"/)
  assert.match(database, /tier\s*= "db-custom-2-7680"/)
  assert.match(database, /availability_type = "REGIONAL"/)
  assert.match(database, /deletion_protection\s*= true/)
  assert.match(database, /deletion_protection_enabled = true/)
  const identity = terraform('push-deploy-identity.tf')
  const lease = identity.match(/resource "google_storage_bucket_iam_member" "github_push_rollout_lease" \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(lease)
  assert.match(lease, /member = local\.push_deploy_member/)
  assert.match(lease, /role\s*= "roles\/storage.objectAdmin"/)
  assert.match(lease, /resource.name == 'projects\/_\/buckets\/\$\{var.project_id\}-terraform-state\/objects\/terraform\/state\/push-rollout\/production.lock'/)
})
