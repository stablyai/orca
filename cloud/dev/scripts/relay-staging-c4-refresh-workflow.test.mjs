import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { relayWorkflowFile, relayWorkflowUrl } from './relay-repository.mjs'

const workflow = readFileSync(
  relayWorkflowUrl('prove-relay-staging-capacity.yml'),
  'utf8'
)
const recoveryWorkflow = readFileSync(
  relayWorkflowUrl('recover-relay-staging-c4-image.yml'),
  'utf8'
)
const requeueWorkflow = readFileSync(
  relayWorkflowUrl('requeue-relay-staging-c4-recovery.yml'),
  'utf8'
)
const githubActions = readFileSync(
  new URL('../../infra/terraform/relay-github-actions.tf', import.meta.url),
  'utf8'
)
const cells = readFileSync(
  new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
  'utf8'
)
const relay = readFileSync(new URL('../../infra/terraform/relay.tf', import.meta.url), 'utf8')
const stagingTfvars = readFileSync(
  new URL('../../infra/terraform/environments/staging.tfvars', import.meta.url),
  'utf8'
)
const productionTfvars = readFileSync(
  new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
  'utf8'
)

const launchDigest = '5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563'

// Scoped to the Asia cells by name: the production capacity cells now serve this digest too,
// so a file-wide count no longer isolates Asia.
const asiaCells = ['production-gce-c27', 'production-gce-c28', 'production-gce-c29']

function productionCell(cellId) {
  const start = productionTfvars.indexOf(`"${cellId}"`)
  assert.notEqual(start, -1, `${cellId} is missing`)
  return productionTfvars.slice(start, productionTfvars.indexOf('\n  }', start))
}

test('pins staging C4 and all production Asia cells to the same launch image', () => {
  assert.equal(stagingTfvars.match(new RegExp(launchDigest, 'g'))?.length, 1)
  for (const cellId of asiaCells) {
    assert.match(productionCell(cellId), new RegExp(`relay@sha256:${launchDigest}"`), cellId)
  }
  assert.match(recoveryWorkflow, new RegExp(`TARGET_IMAGE_DIGEST: sha256:${launchDigest}`))
})

test('refreshes only empty staging C4 through the trusted capacity identity', () => {
  const refresh = workflow.slice(workflow.indexOf('  refresh-asia-c4-image:'))
  assert.match(refresh, /terraform_version: 1\.15\.8/)
  assert.doesNotMatch(refresh, /terraform_version: 1\.5\.7/)
  assert.match(refresh, /github\.ref == 'refs\/heads\/main'/)
  assert.match(refresh, /REFRESH_STAGING_ASIA_C4_IMAGE/)
  assert.match(refresh, /APPROVED_PREDECESSOR_IMAGE_DIGEST/)
  assert.match(refresh, /--activity quiescent/)
  assert.match(refresh, /--admission migration-only/)
  assert.match(refresh, /fence_digests="\$\{PREDECESSOR_IMAGE_DIGEST\}"/)
  assert.match(refresh, /--expected-image-digests "\$\{TARGET_IMAGE_DIGEST\}"/)
  assert.match(refresh, /--mode same-cap-image/)
  assert.match(refresh, /test "\$\(jq -r '\.changes'/)
  assert.match(refresh, /REFRESH_PHASE=\$\{refresh_phase\}/)
  assert.match(refresh, /MUTATION_STARTED=false/)
  assert.match(refresh, /MIG_STABLE_AT_MS=/)
  assert.match(refresh, /PLAN_CHANGES=/)
  assert.match(refresh, /obsolete-template-delete/)
  assert.match(
    refresh,
    /\*:manager-convergence\|\*:replacement-with-obsolete-template\) refresh_phase=converging/
  )
  assert.match(refresh, /--mode isolate/)
  assert.match(refresh, /--mode verify/)
  assert.match(refresh, /\.status\.runtime\.ready/)
  assert.match(refresh, /\.status\.runtime\.startedAt/)
  assert.match(refresh, /\.status\.runtime\.lastHeartbeatAt/)
  assert.match(refresh, /--runtime unavailable/)
  const plan = refresh.indexOf('Save, validate, and classify the exact C4 plan')
  const currentState = refresh.indexOf('Verify the exact selector and current C4 state')
  const isolate = refresh.indexOf('--mode isolate')
  const apply = refresh.indexOf('terraform -chdir=infra/terraform apply -auto-approve')
  assert.ok(plan < currentState && currentState < isolate && isolate < apply)
  assert.match(refresh, /Require an empty targeted Terraform readback/)
})

test('recovers a failed or cancelled C4 refresh from an independent workflow', () => {
  assert.match(recoveryWorkflow, /terraform_version: 1\.15\.8/)
  assert.doesNotMatch(recoveryWorkflow, /terraform_version: 1\.5\.7/)
  assert.match(recoveryWorkflow, /workflow_run:/)
  assert.match(recoveryWorkflow, /workflows: \[Prove Relay Staging Capacity\]/)
  assert.match(recoveryWorkflow, /RECOVER_STAGING_ASIA_C4_IMAGE/)
  assert.match(recoveryWorkflow, /outputs:\n\s+recover: \$\{\{ steps\.trigger\.outputs\.recover \}\}/)
  assert.match(recoveryWorkflow, /if test "\$\{count\}" = 0; then\n\s+echo "recover=false"/)
  assert.match(recoveryWorkflow, /needs: gate\n\s+if: \$\{\{ needs\.gate\.outputs\.recover == 'true' \}\}/)
  assert.match(recoveryWorkflow, /concurrency:\n\s+group: relay-staging-mutation/)
  assert.match(recoveryWorkflow, /group: relay-staging-mutation/)
  assert.match(recoveryWorkflow, /\.name == "refresh-asia-c4-image"/)
  assert.match(recoveryWorkflow, /PREDECESSOR_IMAGE_DIGEST: sha256:ce16d13/)
  assert.match(recoveryWorkflow, /TARGET_IMAGE_DIGEST: sha256:5aedbca5/)
  assert.match(recoveryWorkflow, /id: preflight-auth/)
  assert.match(recoveryWorkflow, /id: verify-auth/)
  assert.match(recoveryWorkflow, /\.status\.runtime\.ready/)
  assert.match(recoveryWorkflow, /--runtime unavailable/)
  assert.match(recoveryWorkflow, /current_digest.*\^sha256:\[a-f0-9\]\{64\}\$/)
  assert.match(recoveryWorkflow, /expected_digests="\$\{expected_digests\},\$\{current_digest\}"/)
  assert.match(recoveryWorkflow, /--timeout-ms 240000/)
  assert.doesNotMatch(recoveryWorkflow, /--timeout-ms 900000/)
  assert.match(recoveryWorkflow, /-var-file=environments\/staging.tfvars -lock-timeout=5m/)
  assert.doesNotMatch(recoveryWorkflow, /manage_artifact_dns/)
  assert.match(recoveryWorkflow, /--mode same-cap-image/)
  assert.match(recoveryWorkflow, /test "\$\(jq -r '\.changes'/)
  assert.equal(recoveryWorkflow.match(/\*:replacement-with-obsolete-template/g)?.length, 2)
  assert.match(
    recoveryWorkflow,
    /\^\(replacement\|replacement-with-obsolete-template\|manager-convergence\)\$/
  )
  const preflightAuth = recoveryWorkflow.indexOf('id: preflight-auth')
  const preflight = recoveryWorkflow.indexOf('Inspect the exact C4 recovery state')
  const recoveryPlan = recoveryWorkflow.indexOf('Classify both exact recovery end states')
  const apply = recoveryWorkflow.indexOf('Apply and stabilize the saved predecessor plan')
  const restore = recoveryWorkflow.indexOf('Restart only when the plan did not replace C4')
  const verifyAuth = recoveryWorkflow.indexOf('id: verify-auth')
  const verify = recoveryWorkflow.indexOf('Verify the recovered image and unchanged isolation')
  assert.ok(preflightAuth < preflight && preflight < recoveryPlan && recoveryPlan < apply)
  assert.ok(apply < restore)
  assert.ok(restore < verifyAuth && verifyAuth < verify)
  assert.match(githubActions, /"recover-relay-staging-c4-image\.yml"/)
})

test('requeues a protected C4 recovery cancelled while pending', () => {
  assert.match(requeueWorkflow, /workflows: \[Recover Relay Staging C4 Image\]/)
  assert.match(requeueWorkflow, /conclusion == 'cancelled'/)
  assert.match(requeueWorkflow, /permissions:\n\s+actions: write\n\s+contents: read/)
  assert.match(requeueWorkflow, /group: relay-staging-c4-recovery-requeue/)
  assert.match(requeueWorkflow, /\.name == "recover" and\n\s+\.conclusion == "cancelled"/)
  assert.match(requeueWorkflow, /\.started_at == null/)
  assert.match(requeueWorkflow, /\.name == "gate" and \.conclusion == "success"/)
  assert.match(requeueWorkflow, /\.name == "recover" and \.status != "completed"/)
  assert.match(requeueWorkflow, /actions\/runs\/\$\{run_id\}\/jobs\?filter=latest/)
  assert.match(requeueWorkflow, /if test "\$\{active\}" != 0; then exit 0; fi/)
  assert.ok(requeueWorkflow.includes(`gh workflow run ${relayWorkflowFile('recover-relay-staging-c4-image.yml')}`))
  assert.match(requeueWorkflow, /-f confirmation=RECOVER_STAGING_ASIA_C4_IMAGE/)
  assert.doesNotMatch(requeueWorkflow, /id-token: write/)
  assert.doesNotMatch(requeueWorkflow, /relay-staging-mutation/)
})

test('keeps cell-only plans independent from service-account description drift', () => {
  assert.match(cells, /runtime_service_account\s+= local\.relay_runtime_service_account_email/)
  assert.match(
    cells,
    /rehome_director_service_account\s+= local\.relay_director_runtime_service_account_email/
  )
  assert.match(relay, /var\.environment == "staging" \? "Orca Relay"/)
})
