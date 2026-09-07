import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isEntrypoint,
  jobIf,
  jobNeeds,
  jobs,
  readWorkflow,
  workflowFiles
} from './cloud-sql-rollout-lock-census.mjs'
import { relayWorkflowFile } from './relay-repository.mjs'

// Why: this repository publishes the relay's operate surface next to the desktop app. Three
// invariants make that safe, and each of them is one careless edit away from being lost.
const OPERATIONS_GATE = "vars.ORCA_CLOUD_OPERATIONS_ENABLED == 'true'"

// Cloud Verify is the only cloud workflow that must run on every pull request.
const UNGATED = relayWorkflowFile('verify.yml')

const relayWorkflows = () => workflowFiles().filter((file) => file !== UNGATED)

test('the copy carries every relay workflow', () => {
  assert.equal(relayWorkflows().length, 24)
})

// Why: workflow_run chains match by display name, not filename. Renaming a file is safe; renaming
// one of these silently breaks the recovery chain with no failing run to notice.
test('the recovery chain keeps the display names it is matched by', () => {
  const names = Object.fromEntries(
    ['prove-relay-staging-capacity.yml', 'recover-relay-staging-c4-image.yml', 'requeue-relay-staging-c4-recovery.yml'].map(
      (name) => [name, /^name: (.+)$/m.exec(readWorkflow(relayWorkflowFile(name)))?.[1]]
    )
  )
  assert.deepEqual(names, {
    'prove-relay-staging-capacity.yml': 'Prove Relay Staging Capacity',
    'recover-relay-staging-c4-image.yml': 'Recover Relay Staging C4 Image',
    'requeue-relay-staging-c4-recovery.yml': 'Requeue Relay Staging C4 Recovery'
  })
  const recover = readWorkflow(relayWorkflowFile('recover-relay-staging-c4-image.yml'))
  const requeue = readWorkflow(relayWorkflowFile('requeue-relay-staging-c4-recovery.yml'))
  assert.ok(recover.includes(`workflows: [${names['prove-relay-staging-capacity.yml']}]`))
  assert.ok(requeue.includes(`workflows: [${names['recover-relay-staging-c4-image.yml']}]`))
})

// Why: this repository holds none of the GCP credentials these workflows would need. Every one
// authenticates through Workload Identity read from a variable, so any repository secret other
// than the automatic token would be a credential the owner has to store here.
test('no cloud workflow reads a repository secret', () => {
  for (const file of workflowFiles()) {
    for (const [, name] of readWorkflow(file).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.equal(name, 'GITHUB_TOKEN', `${file} reads secrets.${name}`)
    }
  }
})

// Why: the operations gate is what makes the whole surface inert until the owner enables it. A
// job that can start without a gated dependency would run the moment someone dispatches it.
test('every job that can start on its own is gated on the operations variable', () => {
  const reachable = []
  for (const file of relayWorkflows()) {
    const text = readWorkflow(file)
    if (!isEntrypoint(text)) continue
    for (const job of jobs(text)) {
      if (jobNeeds(job.text).length > 0) continue
      reachable.push(`${file}:${job.id}`)
      assert.ok(jobIf(job.text).includes(OPERATIONS_GATE), `${file}:${job.id} is not gated`)
    }
  }
  assert.ok(reachable.length >= 20, `only ${reachable.length} root jobs were checked`)
})

// Why: reusable jobs inherit the caller's gate. Gating them again would be dead configuration
// that reads as protection, and every caller is already checked above.
test('reusable workflows carry no gate of their own', () => {
  for (const file of relayWorkflows()) {
    const text = readWorkflow(file)
    if (isEntrypoint(text)) continue
    for (const job of jobs(text)) {
      assert.ok(!jobIf(job.text).includes(OPERATIONS_GATE), `${file}:${job.id} regates a reusable job`)
    }
  }
})
