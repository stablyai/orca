import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { relayWorkflowUrl } from './relay-repository.mjs'

function workflow(name) {
  return readFileSync(
    fileURLToPath(relayWorkflowUrl(name)),
    'utf8'
  )
}

test('same-cap wrapper is reusable, canary-bound, and sequential', () => {
  const wrapper = workflow('deploy-relay-production-same-cap.yml')
  const job = workflow('deploy-relay-production-same-cap-job.yml')
  assert.match(wrapper, /options: \[verify, canary-apply, batch-apply, rollback\]/)
  assert.match(wrapper, /relay-same-cap-canary-\$\{\{ inputs\.canary-run-id \}\}/)
  assert.match(wrapper, /needs: \[gate, cell_1\]/)
  assert.match(wrapper, /needs: \[gate, cell_2\]/)
  assert.match(wrapper, /needs: \[gate, cell_3\]/)
  assert.match(job, /on:\n  workflow_call:/)
  assert.match(job, /c27\|c28\|c29/)
  assert.match(job, /EXPECTED_HARD_CAP=3000/)
  assert.match(job, /EXPECTED_REGION=asia-east2/)
  assert.match(job, /--hard-cap "\$\{EXPECTED_HARD_CAP\}"/)
  assert.match(job, /--regional-rehome-protocol "\$\{DESIRED_REHOME_PROTOCOL\}"/)
  assert.match(job, /--argjson protocol "\$\{PREDECESSOR_REHOME_PROTOCOL\}"/)
  assert.match(job, /runtime predecessor mismatch fields=/)
  // A rollback interrupted between apply and restore must be resumable.
  assert.match(job, /ROLLBACK_RESUME=true/)
  assert.match(job, /test "\$\{LIVE_IMAGE_DIGEST\}" = "\$\{DESIRED_IMAGE_DIGEST\}"/)
  // Resume must skip BOTH the drain (no restart will clear the flag) and the
  // apply (state already converged), and prove convergence instead.
  assert.match(
    job,
    /Reversibly isolate and drain only the selected cell\n        if: \$\{\{ inputs\.mode != 'verify' && env\.ROLLBACK_RESUME != 'true' \}\}/
  )
  assert.match(
    job,
    /Apply only the selected same-cap template and MIG\n        if: \$\{\{ inputs\.mode != 'verify' && env\.ROLLBACK_RESUME != 'true' \}\}/
  )
  assert.match(
    job,
    /Require converged Terraform state and a stable MIG on resume\n        if: \$\{\{ inputs\.mode != 'verify' && env\.ROLLBACK_RESUME == 'true' \}\}/
  )
  assert.match(job, /resume found unconverged resources/)
  // A canary or batch cell that failed before its template apply also
  // resumes here with template drift from repo changes since its last roll;
  // only a plan the reviewed validator approves for the image the cell
  // already serves may pass, and resume still applies nothing.
  assert.match(job, /requiring reviewed rollback-image drift/)
  assert.match(
    job,
    /--image "\$\{DESIRED_IMAGE\}" \\\n {16}--rollback-image "\$\{DESIRED_IMAGE\}"/
  )
  // The relaxation is only safe if the reviewed validator actually runs on
  // the NON-converged branch, in same-cap-cell mode, with the trust config
  // the validator requires, restricted to the template-and-MIG change pair.
  assert.match(
    job,
    /if ! terraform -chdir=infra\/terraform show -json[\s\S]{0,220}\| length == 0' >\/dev\/null\n          then\n/
  )
  assert.match(
    job,
    /requiring reviewed rollback-image drift'\n[\s\S]{0,400}?\n {16}--mode same-cap-cell --cell-id "\$\{TARGET_CELL_ID\}" \\\n/
  )
  assert.match(
    job,
    /Require converged Terraform state and a stable MIG on resume[\s\S]{0,200}DIRECTOR_RUNTIME_SERVICE_ACCOUNT: \$\{\{ vars\.PRODUCTION_GCP_RELAY_DIRECTOR_RUNTIME_SERVICE_ACCOUNT \}\}/
  )
  assert.match(
    job,
    /--rollback-image "\$\{DESIRED_IMAGE\}" \\\n {16}--rehome-director-service-account "\$\{DIRECTOR_RUNTIME_SERVICE_ACCOUNT\}"/
  )
  assert.match(job, /host-drain \\\n {14}\| jq -e '\.changes == 2' >\/dev\/null/)
  assert.match(job, /resume requires the isolated migration-only cell/)
  assert.match(job, /test "\$\{TARGET_INCARNATION\}" = "\$\{SOURCE_INCARNATION\}"/)
  assert.match(job, /\(.regionalRehomeProtocol \/\/ 0\) == \$protocol/)
  assert.match(job, /\(\.draining == false or \$drainingOk\)/)
  // Selector expectations must follow the mutations' returned generations,
  // not fixed offsets: isolate is a no-op on a cell a failed canary already
  // isolated, and the restore inspect must expect post-restore membership.
  assert.match(job, /SELECTOR_GENERATION_AFTER_ISOLATE=\$\{EFFECTIVE_SELECTOR_GENERATION\}/)
  assert.match(job, /SELECTOR_GENERATION_AFTER_ISOLATE=\$\{ISOLATE_GENERATION\}/)
  assert.match(job, /--expected-selector-generation "\$\{SELECTOR_GENERATION_AFTER_ISOLATE\}"/)
  assert.match(job, /--expected-selector-generation "\$\{SELECTOR_GENERATION_AFTER_ACTIVATE\}"/)
  assert.match(job, /--expected-migration-only-cells "\$\{RESTORED_MIGRATION_CELLS\}"/)
  assert.match(job, /--expected-general-cells "\$\{RESTORED_GENERAL_CELLS\}"/)
  assert.match(job, /FAILSAFE_GENERATION/)
  // Later batch waves start after ~16-min predecessor rolls, so BOTH evidence
  // age checks must scale by wave or cell_2+ can never pass; the bound's
  // per-wave step is the cell job timeout, so the two must move together.
  assert.match(job, /--required-migration-policy strict \\\n            --wave-index "\$\{WAVE_INDEX\}"/)
  assert.match(job, /dry-run\.state\.json" \\\n            --wave-index "\$\{WAVE_INDEX\}" "\$\{RETRY_ARGS\[@\]\}"/)
  assert.match(job, /timeout-minutes: 75/)
  // Both age gates step by the cell job timeout above; the constant is
  // duplicated across the two languages, so pin each copy to it.
  for (const source of [
    '../../dev/scripts/relay-monitor-evidence.mjs',
    '../../apps/relay-ops/src/incident-live-preflight-cli.ts'
  ]) {
    const body = readFileSync(fileURLToPath(new URL(source, import.meta.url)), 'utf8')
    assert.match(body, /WAVE_PREDECESSOR_TIMEOUT_MS = 75 \* 60_000/)
    assert.match(body, /\^\[0-3\]\$/)
  }
  // Aged-evidence replay via job re-runs is fenced: mutations are
  // single-dispatch, so a failed cell needs a fresh gate and monitor run.
  assert.match(job, /test "\$\{GITHUB_RUN_ATTEMPT\}" = 1/)
  for (const index of [0, 1, 2, 3]) {
    assert.match(wrapper, new RegExp(`wave-index: '${index}'`))
  }
  assert.doesNotMatch(job, /EFFECTIVE_SELECTOR_GENERATION \+ 1\)/)
  assert.doesNotMatch(job, /EFFECTIVE_SELECTOR_GENERATION \+ 2\)/)
  assert.match(job, /\$region == "us-central1" and \$protocol == 0 and [.]region == null/)
  assert.match(job, /[.]regionalRehomeProtocol \/\/ 0/)
  assert.match(job, /runtime predecessor normalized legacy fields=/)
  assert.match(job, /probe-relay-rehome-trust[.]mjs/)
  assert.doesNotMatch(job, /service_account: \$\{\{ vars\.PRODUCTION_GCP_RELAY_(?:DIRECTOR_)?RUNTIME_SERVICE_ACCOUNT/)
  assert.doesNotMatch(job, /roles\/iam\.serviceAccountTokenCreator/)
})

// Why: the same-cap caller defines release_lease itself, and a caller-defined job presents the
// caller as job_workflow_ref, so the pair must admit the caller alongside its reusable job.
test('shared deploy WIF admits the exact same-cap reusable workflow pair and the caller itself', () => {
  const terraform = readFileSync(
    fileURLToPath(new URL('../../infra/terraform/relay-github-actions.tf', import.meta.url)),
    'utf8'
  )
  const providerStart = terraform.indexOf(
    'resource "google_iam_workload_identity_pool_provider" "github"'
  )
  const providerEnd = terraform.indexOf('\nresource "', providerStart + 1)
  const sharedProvider = terraform.slice(providerStart, providerEnd)
  assert.ok(providerStart >= 0 && providerEnd > providerStart)
  assert.match(sharedProvider, /local\.relay_github_workflow_conditions\["github"\]/)
  // The pairing itself now lives in the clause the provider renders, once per accepted repository.
  assert.match(
    terraform,
    /assertion\.workflow_ref == '\$\{prefix\}\$\{local\.github_production_relay_same_cap_workflow_file\}@refs\/heads\/main' && \(assertion\.job_workflow_ref == '\$\{prefix\}\$\{local\.github_production_relay_same_cap_job_workflow_file\}@refs\/heads\/main' \|\| assertion\.job_workflow_ref == '\$\{prefix\}\$\{local\.github_production_relay_same_cap_workflow_file\}@refs\/heads\/main'\)/
  )
})

test('pause and disable precede optional installation and cloud diagnostics', () => {
  const job = workflow('operate-relay-production-rehome-job.yml')
  const emergency = job.indexOf('Apply emergency durable pause or disable before diagnostics')
  const install = job.indexOf('pnpm install --frozen-lockfile')
  const revision = job.indexOf('Verify exact serving and rollback director identities')
  assert.ok(emergency > 0)
  assert.ok(emergency < install)
  assert.ok(emergency < revision)
  assert.match(job, /inputs\.mode == 'pause' \|\| inputs\.mode == 'disable'/)
  assert.match(job, /Seal 24-hour aggregate region observation evidence/)
  assert.match(job, /--freshness=25h --limit=30000/)
  assert.match(job, /relay-region-observation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(job, /test "\$\{RATE_PER_MINUTE\}" = 10/)
})

test('a failed enable independently restores and verifies durable disabled state', () => {
  const job = workflow('operate-relay-production-rehome-job.yml')
  const enable = job.indexOf('Apply exact durable regional rehome enable')
  const evidence = job.indexOf('Read fresh aggregate completion and abort evidence')
  const summary = job.indexOf('Publish aggregate control evidence')
  const recovery = job.indexOf('Fail closed after an unsuccessful enable run')
  assert.ok(enable > 0 && enable < evidence && evidence < summary && summary < recovery)
  const recoveryStep = job.slice(recovery)
  assert.match(
    recoveryStep,
    /failure\(\) && inputs\.mode == 'enable' && steps\.google-auth\.outcome == 'success'/
  )
  assert.match(recoveryStep, /--mode recover-enable/)
  assert.match(recoveryStep, /--expected-control-generation "\$\{EXPECTED_CONTROL_GENERATION\}"/)
  assert.match(recoveryStep, /RECOVER_FAILED_REGIONAL_REHOME_ENABLE/)
  assert.match(recoveryStep, /\.control\.enabled == false/)
  assert.doesNotMatch(recoveryStep, /gcloud|pnpm/)
})

test('director rollout has a strict one-time identity bootstrap', () => {
  const workflowBody = workflow('deploy-relay-production-director.yml')
  const script = readFileSync(
    fileURLToPath(new URL('./deploy-relay-blue-green.mjs', import.meta.url)),
    'utf8'
  )
  assert.match(workflowBody, /BOOTSTRAP_RELAY_DIRECTOR_REHOME_IDENTITY/)
  assert.match(workflowBody, /--predecessor-runtime-service-account/)
  assert.match(workflowBody, /--expected-rehome-generation/)
  assert.match(script, /args\.push\('--service-account', config\['runtime-service-account'\]\)/)
  assert.match(script, /director predecessor runtime service account does not match/)
  const candidateProof = script.indexOf('await verifyRehomeDisabled(candidate.origin)')
  const trafficMove = script.indexOf('operations.updateTraffic(config, [`--to-tags=')
  assert.ok(candidateProof > 0 && candidateProof < trafficMove)
  assert.equal(script.indexOf('verifyRehomeDisabled', trafficMove), -1)
})

test('rehome job pipes every control result through tee under pipefail', () => {
  const job = workflow('operate-relay-production-rehome-job.yml')
  // Without `shell: bash` the step exit code is tee's, so a thrown inspect/apply passes green.
  assert.match(job, /defaults:\n  run:\n(?:    #.*\n)*    shell: bash\n/)
  assert.ok((job.match(/\| tee "\$\{RUNNER_TEMP\}/g) ?? []).length >= 5)
})
