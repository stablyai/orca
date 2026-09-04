import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { concurrencyBlocks, jobIf, jobs, leaseSteps } from './cloud-sql-rollout-lock-census.mjs'
import { readRelayWorkflow, relayWorkflowFile } from './relay-repository.mjs'

// Why: the push gateway holds the APNs key and is the only thing standing between a paired
// phone and a silent notification pipeline. Its deploy is a blue/green rollout against the
// shared Cloud SQL instance, and each of the guarantees below is one careless edit from gone.
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
  assert.match(workflow, /workload_identity_provider: \$\{\{ vars\.PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER \}\}/)
  assert.match(workflow, /service_account: \$\{\{ vars\.PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT \}\}/)
  assert.match(workflow, /environment: production/)
  for (const [, name] of workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assert.equal(name, 'GITHUB_TOKEN', `the workflow reads secrets.${name}`)
  }
})

// Why: Terraform trusts exact workflow filenames, not a prefix. A rename here without the
// matching tfvars-independent list entry would fail authentication at dispatch time only.
test('Terraform trusts this exact workflow file on the production deploy provider', () => {
  assert.match(terraform('relay-github-actions.tf'), /^\s*"push-deploy\.yml"$/m)
  assert.equal(relayWorkflowFile(WORKFLOW), 'cloud-push-deploy.yml')
})

test('the rollout is serialized and leases the production Cloud SQL rollout lock', () => {
  const blocks = concurrencyBlocks(workflow)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].group, 'production-cloud-sql-rollout')
  assert.equal(blocks[0].cancelInProgress, 'false')
  const steps = leaseSteps(workflow)
  assert.equal(steps.length, 1, 'exactly one lease step, held for the whole run')
  assert.equal(steps[0].bucket, 'onorca-cloud-terraform-state')
  assert.equal(steps[0].object, 'terraform/state/cloud-sql-rollout/production.lock')
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
  // A tagged revision is directly addressable and sits outside the service-wide cap, so the
  // candidate needs its own ceiling or it doubles the gateway's Cloud SQL draw while probing.
  assert.match(workflow, /--max-instances "\$\{PUSH_MAX_INSTANCES\}"/)
  assert.match(workflow, /PUSH_MAX_INSTANCES: 4$/m)
  assert.match(terraform('variables.tf'), /variable "push_max_instances"[\s\S]*?default {5}= 4/)
  assert.ok(
    indexOfStep('Record the serving revision before the rollout') <
      indexOfStep('Deploy the candidate revision with no traffic'),
    'the rollback target must be captured before the candidate exists'
  )
})

test('the candidate is probed on its own URL before any traffic moves', () => {
  const probe = indexOfStep('Probe the candidate readiness endpoint')
  assert.ok(probe > indexOfStep('Deploy the candidate revision with no traffic'))
  assert.ok(probe < indexOfStep('Shift all traffic to the verified candidate'))
  assert.match(workflow, /"\$\{CANDIDATE_URL\}\/ready"/)
  assert.match(workflow, /test "\$\{code\}" = 200/)
  assert.doesNotMatch(workflow, /\$\{CANDIDATE_URL\}\/health/, 'liveness is not readiness')
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
  assert.match(
    workflow,
    /--impersonate-service-account "\$\{PUSH_RUNTIME_SERVICE_ACCOUNT\}"/,
    'the probe must exercise the runtime credential, not the deploy identity'
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

test('the run reports a rollback target and always drops its traffic tag', () => {
  assert.match(workflow, /--to-revisions \$\{ROLLBACK_REVISION\}=100/)
  const cleanup = indexOfStep('Drop the candidate traffic tag')
  assert.equal(cleanup, stepNames().length - 1, 'tag cleanup must be the last step')
  assert.match(workflow, /--remove-tags "\$\{CANDIDATE_TAG\}"/)
  const body = workflow.slice(workflow.indexOf('- name: Drop the candidate traffic tag'))
  assert.match(body, /if: always\(\)/)
})
