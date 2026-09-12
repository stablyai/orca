import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { relayWorkflowUrl } from './relay-repository.mjs'

const workflow = readFileSync(
  relayWorkflowUrl('operate-relay-asia-admission.yml'),
  'utf8'
)
const iam = readFileSync(new URL('../../infra/terraform/relay-github-actions.tf', import.meta.url), 'utf8')
const stagingProof = readFileSync(
  relayWorkflowUrl('prove-relay-asia-staging.yml'),
  'utf8'
)
const directorWorkflow = readFileSync(
  relayWorkflowUrl('deploy-relay-production-director.yml'),
  'utf8'
)
const terraformReadme = readFileSync(
  new URL('../../infra/terraform/README.md', import.meta.url),
  'utf8'
)
const proofIam = readFileSync(
  new URL('../../infra/terraform/relay-asia-proof-iam.tf', import.meta.url),
  'utf8'
)
const relayTerraform = readFileSync(
  new URL('../../infra/terraform/relay.tf', import.meta.url),
  'utf8'
)
const rolloutEvidence = readFileSync(
  new URL('./relay-asia-rollout-evidence.mjs', import.meta.url),
  'utf8'
)
const admissionBudgets = readFileSync(
  new URL('../../packages/relay-contract/src/admission-budgets.ts', import.meta.url),
  'utf8'
)

test('offers the exact audited admission modes under the shared deployment lock', () => {
  for (const mode of [
    'inspect', 'initialize', 'verify', 'register', 'configure', 'promote', 'rollback'
  ]) {
    assert.match(workflow, new RegExp(`\\b${mode}\\b`))
  }
  assert.match(workflow, /production-cloud-sql-rollout/)
  assert.match(workflow, /relay-staging-mutation/)
  assert.match(workflow, /selector-generation/)
  assert.match(workflow, /selector-attempt-id/)
})

test('requires exact confirmations and uses the existing admin identity', () => {
  assert.match(workflow, /INITIALIZE_ADMISSION_SELECTOR/)
  assert.match(workflow, /REGISTER_ASIA_MIGRATION_ONLY/)
  assert.match(workflow, /PROMOTE_ASIA_GENERAL/)
  assert.match(workflow, /ROLLBACK_ASIA_MIGRATION_ONLY/)
  assert.match(workflow, /CONFIGURE_ASIA_DIRECTOR/)
  assert.match(workflow, /GCP_RELAY_DEPLOY_SERVICE_ACCOUNT/)
  assert.match(workflow, /id_token_audience: \$\{\{ env\.DIRECTOR_ORIGIN \}\}\/v1\/admin\/drain/)
  assert.match(iam, /"operate-relay-asia-admission\.yml"/)
})

test('discovers generation read-only and explicitly initializes only generation zero', () => {
  assert.match(workflow, /leave empty only for inspect/)
  assert.match(workflow, /test -z "\$\{EXPECTED_SELECTOR_GENERATION\}"/)
  assert.match(workflow, /test "\$\{EXPECTED_SELECTOR_GENERATION\}" = 0/)
  assert.match(workflow, /\^\(0\|\[1-9\]\[0-9\]\*\)\$/)
  assert.match(workflow, /selector-membership-sha256/)
  assert.match(workflow, /\^\[a-f0-9\]\{64\}\$/)
  assert.match(workflow, /director-image-digest/)
  assert.match(workflow, /\.spec\.containers\[0\]\.image == \$image/)
})

test('uploads one sanitized machine-readable admission result', () => {
  assert.match(workflow, /sanitize-relay-asia-admission-result\.mjs/)
  const upload = /- name: Upload sanitized admission result\n([\s\S]*?)(?=\n      - name:)/
    .exec(workflow)?.[1]
  assert.ok(upload)
  assert.match(
    upload,
    /if: \$\{\{ inputs\.mode != 'configure' && steps\.admission-operation\.outcome == 'success' \}\}/
  )
  assert.match(upload, /uses: actions\/upload-artifact@v4/)
  assert.match(
    upload,
    /relay-asia-admission-result-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  )
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/relay-asia-admission-result\/result\.json/)
  assert.match(upload, /if-no-files-found: error/)
  assert.match(upload, /retention-days: 7/)
  assert.ok(
    workflow.indexOf('Upload sanitized admission result') >
      workflow.indexOf('Upload immutable C27 canary evidence')
  )
})

test('binds selector operations and director configuration to reviewed implementations', () => {
  assert.match(workflow, /operate-relay-asia-admission\.mjs/)
  assert.match(workflow, /prepare-relay-asia-director-cells\.mjs/)
  assert.match(workflow, /deploy-relay-blue-green\.mjs/)
  assert.match(workflow, /--prune-revisions false/)
  assert.doesNotMatch(workflow, /gcloud secrets versions add/)
  assert.match(workflow, /orca-cloud-relay-regional-placement-enabled/)
  assert.match(workflow, /\.valueSource\.secretKeyRef/)
  assert.match(workflow, /jq -er --arg secret "\$\{REGIONAL_PLACEMENT_SECRET\}"/)
  assert.doesNotMatch(workflow, /jq -e --arg secret "\$\{REGIONAL_PLACEMENT_SECRET\}"/)
  assert.doesNotMatch(workflow, /--regional-placement-enabled/)
  assert.doesNotMatch(workflow, /"\$\{\{ inputs\./)
  assert.doesNotMatch(workflow, /dns/i)
})

test('requires immutable staged evidence and a timed C27 canary before expansion', () => {
  assert.match(workflow, /actions: read/)
  assert.match(workflow, /actions\/download-artifact@v4/)
  assert.match(workflow, /relay-asia-staging-\$\{EVIDENCE_RUN_ID\}-\$\{EVIDENCE_RUN_ATTEMPT\}/)
  assert.match(workflow, /evidence_kind=staging/)
  assert.match(workflow, /load-relay-controls\.mjs/)
  assert.match(workflow, /--controls 1/)
  assert.match(workflow, /--splices 1/)
  assert.match(workflow, /--splice-hold-seconds 60/)
  assert.match(workflow, /--relay-asia-load-principals 1/)
  assert.match(workflow, /--duration-seconds 300/)
  assert.match(workflow, /--required-lease-horizons 2/)
  assert.match(workflow, /pnpm\/action-setup@v4/)
  assert.match(workflow, /Install exact C27 canary dependencies/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /pnpm --filter @orca-cloud\/relay-contract build/)
  assert.ok(
    workflow.indexOf('Build the C27 canary Relay contract') <
      workflow.indexOf('Run a real five-minute C27 control and splice canary')
  )
  assert.match(workflow, /--load-report "\$\{RUNNER_TEMP\}\/relay-asia-c27-load\.json"/)
  assert.match(workflow, /states\["production-gce-c28"\].*= migration-only/)
  assert.match(workflow, /states\["production-gce-c29"\].*= migration-only/)
  assert.match(workflow, /relay-asia-c27-canary-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(workflow, /id: c27-evidence-upload/)
  assert.match(workflow, /Return an unproven C27 canary to migration-only/)
  assert.match(workflow, /steps\.c27-evidence-upload\.outcome != 'success'/)
  assert.match(workflow, /--mode recover-promotion[\s\S]*?--attempt-id "\$\{SELECTOR_ATTEMPT_ID\}"/)
  assert.match(workflow, /--attempt-id "\$\{SELECTOR_ATTEMPT_ID\}-rollback"/)
  assert.match(workflow, /evidence_kind=c27/)
  assert.match(workflow, /orca_relay_runtime_metrics/)
  assert.match(workflow, /relay-asia-rollout-evidence\.mjs create-c27/)
  assert.match(workflow, /retention-days: 7/)
  assert.match(workflow, /Require the exact director image before promotion/)
  assert.match(workflow, /DIRECTOR_ORIGIN.*\/v1\/admin\/runtime-status/)
  assert.match(workflow, /\.imageDigest.*IMAGE_DIGEST/)
  const provenance = /- name: Verify evidence provenance and rollout binding before authentication\n([\s\S]*?)(?=\n      - id: auth)/
    .exec(workflow)?.[1]
  assert.ok(provenance)
  assert.match(provenance, /\.head_sha \| select\(type == "string" and test\("\^\[a-f0-9\]\{40\}\$"\)\)/)
  assert.match(provenance, /--commit-sha "\$\{evidence_commit_sha\}"/)
  assert.doesNotMatch(provenance, /--commit-sha "\$\{GITHUB_SHA\}"/)
})

test('creates staging evidence only after the bounded launch-path load and rollback', () => {
  assert.match(stagingProof, /runs-on: \[self-hosted, linux, x64, relay-asia-east2-load\]/)
  assert.doesNotMatch(stagingProof, /group: relay-asia-east2-load/)
  assert.match(stagingProof, /pnpm\/action-setup@v4/)
  assert.match(stagingProof, /pnpm install --frozen-lockfile/)
  assert.match(stagingProof, /pnpm --filter @orca-cloud\/relay-contract build/)
  assert.match(stagingProof, /run_phase launch 5 5/)
  assert.doesNotMatch(stagingProof, /run_phase control|run_phase mixed/)
  assert.match(stagingProof, /--aggregate-controls "\$\(\(controls \* 4\)\)"/)
  assert.match(stagingProof, /--aggregate-splices "\$\(\(splices \* 4\)\)"/)
  assert.match(stagingProof, /--required-lease-horizons 2/)
  assert.match(stagingProof, /--splice-ramp-seconds 120/)
  assert.match(stagingProof, /--max-generator-rss-growth-mib 512/)
  assert.match(stagingProof, /--relay-asia-load-principals 32/)
  assert.match(stagingProof, /ulimit -n/)
  assert.match(stagingProof, /--region-behavior-probes 1/)
  assert.match(stagingProof, /--capacity-cell-origin https:\/\/c4\.relay-staging\.onorca\.dev/)
  assert.match(stagingProof, /--rebind-probes 2/)
  assert.match(stagingProof, /--skip-rebind-overflow-check/)
  assert.doesNotMatch(stagingProof, /--request-unit-invites|--regional-fallback-probes/)
  assert.match(stagingProof, /--aggregate-reader-splices.*echo 5/)
  assert.match(stagingProof, /--aggregate-reader-bytes.*echo 12582912/)
  assert.match(stagingProof, /--phase-barrier-dir "\$\{proof_dir\}\/\$\{phase\}-barrier"/)
  assert.match(stagingProof, /--duration-seconds 210/)
  assert.match(stagingProof, /trap stop_shards EXIT/)
  assert.match(stagingProof, /if ! wait "\$\{pid\}"; then failed=1; break; fi/)
  assert.match(stagingProof, /connectionFailuresByReason/)
  assert.match(stagingProof, /--launch-report "\$\{proof_dir\}\/launch\.json"/)
  assert.match(stagingProof, /id-token: write/)
  assert.match(stagingProof, /STAGING_GCP_RELAY_ASIA_PROOF_WORKLOAD_IDENTITY_PROVIDER/)
  assert.match(stagingProof, /STAGING_GCP_RELAY_ASIA_PROOF_SERVICE_ACCOUNT/)
  assert.doesNotMatch(stagingProof, /STAGING_GCP_DEPLOY_SERVICE_ACCOUNT/)
  assert.doesNotMatch(stagingProof, /STAGING_RELAY_LOAD_ACCESS_TOKEN/)
  assert.doesNotMatch(stagingProof, /secrets versions access|signing-key-file/)
  assert.match(stagingProof, /relay-asia-rollout-evidence\.mjs create-staging/)
  assert.match(stagingProof, /Require the exact staging director image before promotion/)
  assert.match(stagingProof, /DIRECTOR_ORIGIN.*\/v1\/admin\/runtime-status/)
  assert.match(stagingProof, /\.imageDigest.*IMAGE_DIGEST/)
  assert.match(stagingProof, /Return staging C4 to migration-only/)
  assert.match(stagingProof, /steps\.promote\.outcome != 'skipped'/)
  assert.match(stagingProof, /--mode recover-promotion[\s\S]*?--attempt-id "\$\{PROMOTE_ATTEMPT_ID\}"/)
  assert.match(stagingProof, /--mode rollback[\s\S]*?--expected-generation "\$\{promoted_generation\}"/)
  assert.match(stagingProof, /if: \$\{\{ success\(\) \}\}/)
  assert.match(
    stagingProof,
    /recover:\n    if: \$\{\{ always\(\) && github\.ref == 'refs\/heads\/main' \}\}/
  )
  assert.match(stagingProof, /needs: prove/)
  assert.match(stagingProof, /Recover staging C4 with a fresh identity/)
  assert.equal((stagingProof.match(/google-github-actions\/auth@v2/g) ?? []).length, 2)
  assert.equal((stagingProof.match(/--mode recover-promotion/g) ?? []).length, 2)
  assert.equal((stagingProof.match(/--mode rollback/g) ?? []).length, 2)
})

test('keeps the private runner below its 64-port Cloud NAT allocation', () => {
  const profile = /run_phase launch (\d+) (\d+)/.exec(stagingProof)
  const controlsPerShard = Number(profile?.[1])
  const splicesPerShard = Number(profile?.[2])
  const rebindProbes = Number(/--rebind-probes (\d+)/.exec(stagingProof)?.[1])
  const runtimeStatusSockets = 1
  assert.ok(
    controlsPerShard * 4 + splicesPerShard * 4 * 2 + rebindProbes + runtimeStatusSockets < 64
  )
})

test('paces one-source staging upgrades below the Relay anti-abuse ceiling', () => {
  const splicesPerShard = Number(/run_phase launch \d+ (\d+)/.exec(stagingProof)?.[1])
  const rebindProbes = Number(/--rebind-probes (\d+)/.exec(stagingProof)?.[1])
  const spliceRampMs = Number(/--splice-ramp-seconds (\d+)/.exec(stagingProof)?.[1]) * 1000
  const ceiling = Number(
    /maxPreAuthAttemptsPerSourcePerMinute: (\d+)/.exec(admissionBudgets)?.[1]
  )
  const totalSplices = splicesPerShard * 4
  const attempts = Array.from({ length: totalSplices }, (_, ordinal) =>
    Math.floor(ordinal * spliceRampMs / (totalSplices - 1))
  ).flatMap((startedAt) => [startedAt, startedAt])
  attempts.push(...Array.from({ length: 4 + rebindProbes }, () => 0))
  const busiestMinute = Math.max(...attempts.map((startedAt) =>
    attempts.filter((attempt) => attempt >= startedAt && attempt < startedAt + 60_000).length
  ))
  assert.ok(busiestMinute < ceiling)
})

test('reserves rollback time beyond the complete bounded staging proof envelope', () => {
  const timeoutMinutes = Number(/timeout-minutes: (\d+)/.exec(stagingProof)?.[1])
  assert.equal(timeoutMinutes, 75)
  const spliceRampSeconds = Number(/--splice-ramp-seconds (\d+)/.exec(stagingProof)?.[1])
  const launchSeconds = 180 + spliceRampSeconds + 210 + 60
  const setupEvidenceAndRollbackSeconds = 10 * 60
  const envelopeMinutes = Math.ceil((launchSeconds + setupEvidenceAndRollbackSeconds) / 60)
  assert.ok(timeoutMinutes - envelopeMinutes >= 30)
  assert.match(stagingProof, /--ramp-seconds 180/)
  assert.match(stagingProof, /--duration-seconds 210/)
})

test('binds the staging proof to one least-privilege Google identity', () => {
  assert.match(
    proofIam,
    /github_relay_asia_proof_workflow_file = "prove-relay-asia-staging\.yml"/
  )
  assert.match(
    proofIam,
    /assertion\.workflow_ref == '\$\{prefix\}\$\{local\.github_relay_asia_proof_workflow_file\}@refs\/heads\/main'/
  )
  assert.match(proofIam, /assertion\.environment == 'staging'/)
  assert.match(proofIam, /assertion\.event_name == 'workflow_dispatch'/)
  assert.match(proofIam, /roles\/logging\.viewer/)
  assert.match(proofIam, /roles\/monitoring\.viewer/)
  assert.match(rolloutEvidence, /readCloudSqlBackends/)
  assert.match(rolloutEvidence, /cloudSql: await readCloudSqlBackends/)
  assert.doesNotMatch(proofIam, /compute\.|cloudsql\.|secretmanager\.|roles\/editor|roles\/run\./)
})

test('keeps the production US-first switch in durable Secret Manager state', () => {
  assert.match(directorWorkflow, /options: \[preserve, enable, disable\]/)
  assert.match(directorWorkflow, /default: preserve/)
  assert.match(directorWorkflow, /gcloud secrets versions add/)
  assert.match(directorWorkflow, /preserve\) desired="\$\{current\}"/)
  assert.match(directorWorkflow, /--regional-placement-secret-version "\$\{target_version\}"/)
  assert.match(directorWorkflow, /test "\$\{CEILING\}" = "\$\{DIRECTOR_MAX_INSTANCES\}"/)
  assert.match(directorWorkflow, /orca-cloud-relay-regional-placement-enabled/)
  assert.match(directorWorkflow, /\.valueSource\.secretKeyRef \/\/ \.valueFrom\.secretKeyRef/)
  assert.match(directorWorkflow, /\.version \/\/ \.key/)
  assert.match(directorWorkflow, /\.secret \/\/ \.name/)
  assert.match(workflow, /\.valueSource\.secretKeyRef \/\/ \.valueFrom\.secretKeyRef/)
  assert.doesNotMatch(directorWorkflow, /--regional-placement-enabled/)
  assert.doesNotMatch(workflow, /inputs\.regional-placement-enabled/)
})

test('prunes incompatible production revisions only when explicitly confirmed', () => {
  assert.match(
    directorWorkflow,
    /prune-incompatible-revisions:[\s\S]*?default: false[\s\S]*?type: boolean/
  )
  assert.match(directorWorkflow, /PRUNE_INCOMPATIBLE_RELAY_DIRECTOR_REVISIONS/)
  assert.match(
    directorWorkflow,
    /test "\$\{REGIONAL_PLACEMENT_MODE\}" = preserve[\s\S]*?test "\$\{CONFIRMATION\}" = PRUNE_INCOMPATIBLE_RELAY_DIRECTOR_REVISIONS/
  )
  assert.match(
    directorWorkflow,
    /--prune-revisions "\$\{PRUNE_INCOMPATIBLE_REVISIONS\}"/
  )
})

test('documents the exact regional-placement secret bootstrap before director rollout', () => {
  for (const address of [
    'google_secret_manager_secret.relay_regional_placement_enabled',
    'google_secret_manager_secret_version.relay_regional_placement_enabled',
    'google_secret_manager_secret_iam_member.relay_regional_placement_runtime_accessor',
    'google_secret_manager_secret_iam_member.relay_regional_placement_deploy_accessor[0]',
    'google_secret_manager_secret_iam_member.relay_regional_placement_deploy_adder[0]',
    'google_secret_manager_secret_iam_member.relay_regional_placement_deploy_viewer[0]'
  ]) {
    assert.match(terraformReadme, new RegExp(address.replaceAll(/[.[\]]/g, '\\$&')))
  }
  assert.match(terraformReadme, /Before the first director deployment/)
  assert.match(terraformReadme, /Pass the exact environment tfvars/)
  // The Cloudflare records left with the apps root; a -var for a variable this root no longer
  // declares is a hard error, so no relay procedure may still tell an operator to pass it.
  assert.doesNotMatch(terraformReadme, /manage_artifact_dns/)
  assert.match(terraformReadme, /exactly these six additions/)
  assert.match(terraformReadme, /version metadata/)
  assert.match(
    relayTerraform,
    /resource "google_secret_manager_secret_iam_member" "relay_regional_placement_deploy_viewer"[\s\S]*?role\s+= "roles\/secretmanager\.viewer"/
  )
})
