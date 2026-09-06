import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  LEASED_WORKFLOWS,
  LOCK_GROUPS,
  NOT_A_CLOUD_SQL_CANDIDATE,
  PRODUCTION_LEASE,
  SELECTABLE_LEASE,
  STAGING_LEASE,
  concurrencyBlocks,
  entrypointsFor,
  jobIf,
  jobNeeds,
  jobs,
  leaseSteps,
  leaseStepsByJob,
  mutatesSharedInstance,
  readWorkflow,
  reusableCalls,
  revisionMintingScripts,
  workflowFiles
} from './cloud-sql-rollout-lock-census.mjs'
import { relayWorkflowFile } from './relay-repository.mjs'

const expectedLease = { production: PRODUCTION_LEASE, staging: STAGING_LEASE, selectable: SELECTABLE_LEASE }
const leasedFiles = Object.keys(LEASED_WORKFLOWS)

function contractFiles(file) {
  return [file, ...(LEASED_WORKFLOWS[file].leaseFiles ?? [])]
}

test('every locked workflow declares exactly one lock group that never cancels', () => {
  for (const file of leasedFiles) {
    const blocks = concurrencyBlocks(readWorkflow(file))
    assert.equal(blocks.length, 1, `${file} must declare exactly one concurrency block`)
    assert.equal(blocks[0].group, LEASED_WORKFLOWS[file].group, file)
    assert.equal(blocks[0].cancelInProgress, 'false', file)
  }
})

test('every locked workflow takes the lease for its own environment', () => {
  for (const file of leasedFiles) {
    const lease = expectedLease[LEASED_WORKFLOWS[file].env]
    const steps = contractFiles(file).flatMap((member) => leaseSteps(readWorkflow(member)))
    assert.ok(steps.length > 0, `${file} must use the Cloud SQL rollout lease action`)
    for (const step of steps) {
      assert.equal(step.bucket, lease.bucket, file)
      assert.equal(step.object, lease.object, file)
    }
  }
})

test('the lease step runs after the credential that authorizes it', () => {
  for (const file of leasedFiles) {
    for (const member of contractFiles(file)) {
      const text = readWorkflow(member)
      const lines = text.split('\n')
      for (const step of leaseSteps(text)) {
        const before = lines.slice(0, step.line - 1)
        const gcloud = before.lastIndexOf('      - uses: google-github-actions/setup-gcloud@v2')
        assert.notEqual(gcloud, -1, `${member}: lease step at line ${step.line} has no setup-gcloud before it`)
        assert.ok(
          before.lastIndexOf('      - uses: actions/checkout@v4') !== -1,
          `${member}: lease step at line ${step.line} runs before the local action is checked out`
        )
      }
    }
  }
})

test('multi-wave workflows hold one lease per run and free it exactly once', () => {
  for (const file of leasedFiles) {
    const entry = LEASED_WORKFLOWS[file]
    const waveFiles = entry.leaseFiles ?? []
    const callCount = waveFiles.reduce(
      (total, member) => total + (reusableCalls(readWorkflow(file)).get(member) ?? 0),
      0
    )
    if (!entry.reentrant) {
      assert.ok(callCount <= 1, `${file} calls a leased reusable job ${callCount} times; it needs a release job`)
      for (const member of contractFiles(file)) {
        for (const step of leaseSteps(readWorkflow(member))) {
          assert.equal(step.release, undefined, `${member} must leave release at its default`)
        }
      }
      continue
    }

    assert.ok(callCount > 1, `${file} no longer calls its reusable job more than once`)
    const steps = contractFiles(file).flatMap((member) => leaseSteps(readWorkflow(member)))
    const released = steps.filter((step) => step.release === "'true'")
    assert.equal(released.length, 1, `${file} must free the run lease exactly once`)
    for (const step of steps) {
      if (step === released[0]) continue
      assert.equal(step.release, "'false'", `${file} wave jobs must hold the lease`)
    }

    const callerJobs = jobs(readWorkflow(file))
    const releaseJob = leaseStepsByJob(file).find((job) =>
      job.steps.some((step) => step.release === "'true'")
    )
    assert.ok(releaseJob, `${file} must free the lease from its own job`)
    const guard = jobIf(callerJobs.find((job) => job.id === releaseJob.id).text)
    assert.match(guard, /always\(\)/, `${file}: the release job must run on failure and cancellation`)

    const holders = callerJobs
      .filter(
        (job) =>
          job.id !== releaseJob.id &&
          (waveFiles.some((member) => job.text.includes(`uses: ./.github/workflows/${member}`)) ||
            leaseStepsByJob(file).find((entry) => entry.id === job.id)?.steps.length > 0)
      )
      .map((job) => job.id)
    const needs = jobNeeds(callerJobs.find((job) => job.id === releaseJob.id).text)
    for (const holder of holders) {
      assert.ok(needs.includes(holder), `${file}: the release job must need ${holder}`)
    }
  }
})

test('workflows with two lease-holding jobs can never run them together', () => {
  for (const file of leasedFiles) {
    const entry = LEASED_WORKFLOWS[file]
    if (entry.reentrant) continue
    const holding = leaseStepsByJob(file).filter((job) => job.steps.length > 0)
    if (holding.length <= 1) continue
    assert.ok(entry.exclusiveBy, `${file} has ${holding.length} lease-holding jobs and no exclusivity guard`)
    const guards = holding.map((job) => jobIf(jobs(readWorkflow(file)).find((j) => j.id === job.id).text))
    assert.equal(
      guards.filter((guard) => guard.includes(entry.exclusiveBy)).length,
      1,
      `${file}: exactly one job may run when ${entry.exclusiveBy}`
    )
    assert.equal(
      guards.filter((guard) => guard.includes(entry.exclusiveBy.replace('==', '!='))).length,
      guards.length - 1,
      `${file}: every other lease-holding job must be excluded when ${entry.exclusiveBy}`
    )
  }
})

test('census: no workflow rolls out against the shared instance outside the lease', () => {
  const minters = revisionMintingScripts()
  assert.ok(minters.size > 0, 'the revision-minting script scan found nothing and is vacuous')
  const flagged = new Map()
  for (const file of workflowFiles()) {
    const reason = mutatesSharedInstance(readWorkflow(file), minters)
    if (reason) flagged.set(file, reason)
  }
  assert.ok(flagged.size > 0, 'the rollout census found no candidates and is vacuous')

  for (const [file, reason] of flagged) {
    for (const entrypoint of entrypointsFor(file)) {
      assert.ok(
        entrypoint in LEASED_WORKFLOWS || entrypoint in NOT_A_CLOUD_SQL_CANDIDATE,
        `${entrypoint} reaches ${file} (${reason}) but is neither leased nor recorded as a non-candidate`
      )
    }
  }

  for (const file of workflowFiles()) {
    const groups = concurrencyBlocks(readWorkflow(file)).map((block) => block.group)
    if (!groups.some((group) => LOCK_GROUPS.has(group))) continue
    assert.ok(
      file in LEASED_WORKFLOWS || file in NOT_A_CLOUD_SQL_CANDIDATE,
      `${file} sits in a Cloud SQL lock group but is neither leased nor recorded as a non-candidate`
    )
  }

  for (const [file, reason] of Object.entries(NOT_A_CLOUD_SQL_CANDIDATE)) {
    assert.ok(typeof reason === 'string' && reason.length > 40, `${file} needs a real reason`)
    const groups = concurrencyBlocks(readWorkflow(file)).map((block) => block.group)
    assert.ok(
      flagged.has(file) || groups.some((group) => LOCK_GROUPS.has(group)),
      `${file} is recorded as a non-candidate but nothing would have flagged it`
    )
  }

  for (const file of leasedFiles) {
    assert.doesNotThrow(() => readWorkflow(file), `${file} is leased but does not exist`)
    assert.ok(!(file in NOT_A_CLOUD_SQL_CANDIDATE), `${file} cannot be both leased and a non-candidate`)
  }
})

// The API and auth deploy scripts share this contract but stay in the private repository.
const serviceCapScripts = ['dev/scripts/deploy-relay-blue-green.mjs']

test('budgets tagged Cloud Run candidates outside the service-wide instance cap', () => {
  for (const file of serviceCapScripts) {
    const script = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.match(script, /'--no-traffic'/, file)
    assert.match(script, /'--max'/, file)
  }
  const budget = readFileSync(
    new URL('../../dev/scripts/relay-cloud-sql-connection-budget.mjs', import.meta.url),
    'utf8'
  )
  assert.match(budget, /directly addressable tagged revisions outside service-level caps/)
  assert.match(
    budget,
    /apiCandidate: retainedDirectorRollback \+ inputs\.apiInstances \* inputs\.apiPoolMax/
  )
  const director = readWorkflow(relayWorkflowFile('deploy-relay-production-director.yml'))
  const capacity = readWorkflow(relayWorkflowFile('deploy-relay-production-capacity-job.yml'))
  const asia = readWorkflow(relayWorkflowFile('operate-relay-asia-admission.yml'))
  assert.match(director, /--max-instances "\$\{DIRECTOR_MAX_INSTANCES\}"/)
  assert.match(capacity, /--max-instances 5/)
  assert.match(asia, /--max-instances "\$\{DIRECTOR_MAX_INSTANCES\}"/)
})
