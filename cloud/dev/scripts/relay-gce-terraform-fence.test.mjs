import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  abortSupersededTerraformFenceBeforeUpload,
  abortTerraformFenceBeforeApply,
  adoptLegacyTerraformFence,
  assertReviewedFenceCheckout,
  assertTerraformFenceSet,
  assertTerraformFenceStateFenced,
  assertTerraformFenceZeroDiff,
  classifyTerraformFenceProgress,
  deleteTerraformFencePlan,
  inspectCompletedTerraformFenceProgress,
  inspectTerraformFenceProgress,
  recoverSupersededCompletedTerraformFence,
  runTerraformFenceApply,
  resumeTerraformFence,
  terraformFenceState,
  terraformProcessStdio,
  validateTerraformFenceCompletionPlan,
  validateTerraformFencePlan
} from './relay-gce-terraform-fence.mjs'

const cell = {
  cellId: 'production-gce-c1',
  migName: 'orca-relay-c1',
  zone: 'us-central1-a',
  instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
  generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
  fenced: true,
  desiredTargetSize: 0
}

const expected = {
  cellId: cell.cellId,
  name: cell.migName,
  zone: cell.zone,
  instance_group: cell.instanceGroup,
  generationIdentity: cell.generationIdentity
}
const stateLineage = 'c739dab4-e6e1-e627-02a9-504b3dda1a2c'

test('adopts a legacy fence only after repeated no-op and live guards', async () => {
  const events = []
  const calls = []
  await adoptLegacyTerraformFence(
    {
      environment: 'production',
      terraformDir: 'infra/terraform',
      varFile: 'environments/production.tfvars',
      fenceCommit: 'a'.repeat(40),
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      cell
    },
    {
      environment: { ORCA_RELAY_FENCE_IMAGE_COMMIT: 'a'.repeat(40) },
      readFile: () => Buffer.from('reviewed variables'),
      loadAttempt: async () => {
        calls.push('attempt')
        return null
      },
      assertCommittedFenceSet: async () => calls.push('fence-set'),
      preApplyGuard: async () => calls.push('pre'),
      assertStateFenced: async () => calls.push('state-fenced'),
      postApplyGuard: async () => calls.push('post'),
      attest: async () => calls.push('attest'),
      commitAdoption: async () => calls.push('commit'),
      emit: (event) => events.push(event)
    }
  )
  assert.deepEqual(calls, [
    'attempt',
    'fence-set',
    'pre',
    'state-fenced',
    'post',
    'attempt',
    'attest',
    'post',
    'commit'
  ])
  assert.deepEqual(events, [
    { event: 'terraform_cell_fence_legacy_adopted', cellId: cell.cellId }
  ])
})

test('refuses legacy adoption when a durable attempt appears during proof', async () => {
  let reads = 0
  let attested = false
  await assert.rejects(
    adoptLegacyTerraformFence(
      {
        environment: 'production',
        terraformDir: 'infra/terraform',
        varFile: 'environments/production.tfvars',
        fenceCommit: 'a'.repeat(40),
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        cell
      },
      {
        environment: { ORCA_RELAY_FENCE_IMAGE_COMMIT: 'a'.repeat(40) },
        readFile: () => Buffer.from('reviewed variables'),
        loadAttempt: async () => (++reads === 1 ? null : { attemptId: 'new' }),
        assertCommittedFenceSet: async () => {},
        preApplyGuard: async () => {},
        assertStateFenced: async () => {},
        postApplyGuard: async () => {},
        attest: async () => {
          attested = true
        },
        commitAdoption: async () => {}
      }
    ),
    /durable fence attempt appeared/
  )
  assert.equal(attested, false)
})

test('does not commit legacy adoption when the final guard fails', async () => {
  let postGuards = 0
  let committed = false
  await assert.rejects(
    adoptLegacyTerraformFence(
      {
        environment: 'production',
        terraformDir: 'infra/terraform',
        varFile: 'environments/production.tfvars',
        fenceCommit: 'a'.repeat(40),
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        cell
      },
      {
        environment: { ORCA_RELAY_FENCE_IMAGE_COMMIT: 'a'.repeat(40) },
        readFile: () => Buffer.from('reviewed variables'),
        loadAttempt: async () => null,
        assertCommittedFenceSet: async () => {},
        preApplyGuard: async () => {},
        assertStateFenced: async () => {},
        postApplyGuard: async () => {
          postGuards++
          if (postGuards === 2) throw new Error('final guard failed')
        },
        attest: async () => {},
        commitAdoption: async () => {
          committed = true
        }
      }
    ),
    /final guard failed/
  )
  assert.equal(committed, false)
})

test('pipes reviewed Terraform console expressions to stdin', () => {
  assert.deepEqual(
    terraformProcessStdio({ encoding: 'utf8', input: 'contains(...)\n' }),
    ['pipe', 'pipe', 'pipe']
  )
  assert.deepEqual(terraformProcessStdio({ encoding: 'utf8' }), [
    'ignore',
    'pipe',
    'pipe'
  ])
  assert.equal(terraformProcessStdio(), 'inherit')
})

test('checks the exact committed fence cell through Terraform console', () => {
  let invocation
  assertTerraformFenceSet(
    {
      terraformDir: 'infra/terraform',
      varFile: 'environments/production.tfvars',
      cell
    },
    {
      terraform: (args, options) => {
        invocation = { args, options }
        return 'true\n'
      }
    }
  )
  assert.deepEqual(invocation.args, [
    '-chdir=infra/terraform',
    'console',
    '-var-file=environments/production.tfvars'
  ])
  assert.equal(
    invocation.options.input,
    'contains(var.relay_gce_fenced_cells, "production-gce-c1") && ' +
      'try(local.relay_gce_cell_target_sizes["production-gce-c1"], -1) == 0\n'
  )
})

test('binds a gitless broker checkout to its immutable image commit', () => {
  const config = {
    fenceCommit: 'a'.repeat(40),
    terraformDir: 'infra/terraform',
    varFile: 'environments/production.tfvars'
  }
  const contents = Buffer.from('reviewed production variables')
  const digest = assertReviewedFenceCheckout(config, {
    environment: { ORCA_RELAY_FENCE_IMAGE_COMMIT: config.fenceCommit },
    readFile: () => contents,
    git: () => {
      throw new Error('git must not run inside the immutable broker image')
    }
  })
  assert.equal(digest, createHash('sha256').update(contents).digest('hex'))
})

test('rejects a broker image built for a different fence commit', () => {
  assert.throws(
    () =>
      assertReviewedFenceCheckout(
        {
          fenceCommit: 'a'.repeat(40),
          terraformDir: 'infra/terraform',
          varFile: 'environments/production.tfvars'
        },
        {
          environment: { ORCA_RELAY_FENCE_IMAGE_COMMIT: 'b'.repeat(40) },
          readFile: () => Buffer.from('reviewed production variables')
        }
      ),
    /immutable broker image/
  )
})

function plan(actions = ['update'], address = undefined) {
  return {
    resource_changes: [
      {
        address:
          address ??
          `google_compute_instance_group_manager.relay_gce_cell["${cell.cellId}"]`,
        change: {
          actions,
          before: {
            name: cell.migName,
            zone: cell.zone,
            instance_group: cell.instanceGroup,
            target_size: 1,
            version: [{ instance_template: cell.generationIdentity }]
          },
          after: {
            name: cell.migName,
            zone: cell.zone,
            instance_group: cell.instanceGroup,
            target_size: 0,
            version: [{ instance_template: cell.generationIdentity }]
          }
        }
      }
    ]
  }
}

function state(targetSize = 0) {
  return {
    values: {
      root_module: {
        resources: [
          {
            address:
              `google_compute_instance_group_manager.relay_gce_cell["${cell.cellId}"]`,
            values: {
              name: cell.migName,
              zone: cell.zone,
              instance_group: cell.instanceGroup,
              target_size: targetSize,
              version: [{ instance_template: cell.generationIdentity }]
            }
          }
        ]
      }
    }
  }
}

test('accepts only one exact in-place MIG resize from one to zero', () => {
  assert.equal(validateTerraformFencePlan(plan(), expected).change.after.target_size, 0)
  for (const actions of [['create'], ['delete'], ['delete', 'create']]) {
    assert.throws(() => validateTerraformFencePlan(plan(actions), expected))
  }
  assert.throws(() =>
    validateTerraformFencePlan(
      plan(['update'], 'google_compute_backend_service.relay_gce_cell["production-gce-c1"]'),
      expected
    )
  )
  const unrelated = plan()
  unrelated.resource_changes.push({
    address: 'google_compute_url_map.relay_gce[0]',
    change: { actions: ['update'], before: {}, after: {} }
  })
  assert.throws(() => validateTerraformFencePlan(unrelated, expected))
})

function completionPlan() {
  const result = plan()
  const before = result.resource_changes[0].change.before
  const after = result.resource_changes[0].change.after
  before.target_size = 0
  before.version[0].name = '0/2026-07-31 03:52:56.639922+00:00'
  after.version[0].name = 'primary'
  return result
}

test('accepts only the empty MIG provider version-label normalization', () => {
  assert.equal(validateTerraformFenceCompletionPlan({ resource_changes: [] }, expected), undefined)
  assert.equal(
    validateTerraformFenceCompletionPlan(completionPlan(), expected).change.after.version[0]
      .name,
    'primary'
  )

  const resized = completionPlan()
  resized.resource_changes[0].change.after.target_size = 1
  assert.throws(() => validateTerraformFenceCompletionPlan(resized, expected))

  const replaced = completionPlan()
  replaced.resource_changes[0].change.after.version[0].instance_template += '-other'
  assert.throws(() => validateTerraformFenceCompletionPlan(replaced, expected))

  const extraChange = completionPlan()
  extraChange.resource_changes[0].change.after.update_policy = { type: 'PROACTIVE' }
  assert.throws(() => validateTerraformFenceCompletionPlan(extraChange, expected))

  const arbitraryLabel = completionPlan()
  arbitraryLabel.resource_changes[0].change.before.version[0].name = 'other'
  assert.throws(() => validateTerraformFenceCompletionPlan(arbitraryLabel, expected))
})

test('binds Terraform state to the exact MIG generation', () => {
  assert.equal(terraformFenceState(state(0), expected), 0)
  const replaced = state(0)
  replaced.values.root_module.resources[0].values.version[0].instance_template += '-other'
  assert.throws(() => terraformFenceState(replaced, expected))
})

test('requires Terraform state to record the exact completed fence', () => {
  let invocation
  assertTerraformFenceStateFenced(applyConfig(), {
    terraform: (args) => {
      invocation = args
      return JSON.stringify(state(0))
    }
  })
  assert.deepEqual(invocation, ['-chdir=infra/terraform', 'show', '-json'])

  assert.throws(
    () =>
      assertTerraformFenceStateFenced(applyConfig(), {
        terraform: () => JSON.stringify(state(1))
      }),
    /does not record the requested cell fence/
  )
  const replaced = state(0)
  replaced.values.root_module.resources[0].values.version[0].instance_template += '-other'
  assert.throws(() =>
    assertTerraformFenceStateFenced(applyConfig(), {
      terraform: () => JSON.stringify(replaced)
    })
  )
})

test('builds and verifies fence plans without unrelated live refreshes', () => {
  let zeroDiffArgs
  assertTerraformFenceZeroDiff(applyConfig(), {
    terraform: (args) => {
      if (args.includes('plan')) zeroDiffArgs = args
      if (args.includes('show')) return JSON.stringify({ resource_changes: [] })
    }
  })
  assert.equal(zeroDiffArgs.includes('-refresh=false'), true)
  assert.equal(
    zeroDiffArgs.includes(
      '-target=google_compute_instance_group_manager.relay_gce_cell["production-gce-c1"]'
    ),
    true
  )
})

test('classifies complete, in-progress, and conclusively not-started fences', () => {
  assert.equal(
    classifyTerraformFenceProgress({
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationAuditBound: true
    }),
    'complete'
  )
  assert.equal(
    classifyTerraformFenceProgress({
      stateTargetSize: 1,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'RUNNING'
    }),
    'in-progress'
  )
  assert.equal(
    classifyTerraformFenceProgress({
      stateTargetSize: 1,
      liveTargetSize: 1,
      instanceCount: 1,
      operationStatus: 'ABSENT'
    }),
    'not-started'
  )
  assert.equal(
    classifyTerraformFenceProgress({
      stateTargetSize: 1,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationAuditBound: true
    }),
    'reconcile-state'
  )
  assert.throws(
    () =>
      classifyTerraformFenceProgress({
        stateTargetSize: 0,
        liveTargetSize: 0,
        instanceCount: 0,
        operationStatus: 'DONE',
        operationAuditBound: false
      }),
    /audit binding/
  )
})

function applyHarness({
  loseApplyResponse = false,
  guardError = null,
  postGuardError = null,
  tamperPlan = false,
  progress
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-fence-test-'))
  const calls = []
  const applyEnvironments = []
  const events = []
  let planPath
  let progressReads = 0
  const terraform = (args, options = {}) => {
    calls.push(args)
    if (args.includes('state') && args.includes('pull')) {
      return JSON.stringify({ lineage: stateLineage, serial: 7 })
    }
    if (args.includes('plan')) {
      planPath = args.find((arg) => arg.startsWith('-out=')).slice(5)
      writeFileSync(planPath, 'private saved plan', { mode: 0o644 })
      chmodSync(planPath, 0o644)
      return
    }
    if (args.includes('show')) return JSON.stringify(plan())
    if (args.includes('apply')) {
      applyEnvironments.push(options.env)
      if (loseApplyResponse) throw new Error('lost response')
    }
  }
  const evidence = []
  return {
    root,
    calls,
    events,
    evidence,
    applyEnvironments,
    planPath: () => planPath,
    overrides: {
      terraform,
      git: (args) => {
        if (args.includes('rev-parse')) return `${applyConfig().fenceCommit}\n`
        return ''
      },
      assertCommittedFenceSet: async () => {},
      tmpdir: () => root,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      inspectProgress: async () => {
        if (progressReads++ === 0) {
          return {
            stateTargetSize: 1,
            liveTargetSize: 1,
            instanceCount: 1,
            operationStatus: 'ABSENT',
            operationError: false,
            operationAuditBound: false,
            stateLineage,
            stateSerial: 7,
            invocationOperations: []
          }
        }
        return progress ?? {
          stateTargetSize: 0,
          liveTargetSize: 0,
          instanceCount: 0,
          operationStatus: 'DONE',
          operationError: false,
          operationAuditBound: true,
          stateLineage,
          stateSerial: 8,
          gceOperation: 'operation-1',
          invocationOperations: [
            {
              invocationId: '11111111-1111-4111-8111-111111111111',
              requestReason:
                'orca-relay-fence/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111',
              startedAt: 101,
              gceOperation: 'operation-1',
              operationStatus: 'DONE',
              operationError: false,
              auditBound: true
            }
          ]
        }
      },
      uploadPlan: async () => ({ generation: '123456789' }),
      stateObjectBinding: async () => ({
        generation: '987654321',
        sha256: createHash('sha256').update('pre-state object').digest('hex'),
        lineage: stateLineage,
        serial: 7
      }),
      bindPlan: async (value) => {
        evidence.push(['bind', value])
        return { attempt: value }
      },
      deletePlan: async (value) => evidence.push(['delete', value]),
      assertZeroDiff: async () => {},
      prepareAttempt: async (value) => {
        evidence.push(['prepare', value])
        return { attempt: { ...value, createdAt: 100, expiresAt: 3_600_100 } }
      },
      markApplyStarted: async (value, invocation) => {
        const started = { ...value, applyStartedAt: 101 }
        const durableInvocation = { ...invocation, startedAt: 101 }
        evidence.push(['started', started])
        return { attempt: started, invocation: durableInvocation }
      },
      markOperation: async (value, invocation) => {
        const durableInvocation = {
          ...invocation,
          gceOperation: value.gceOperation
        }
        evidence.push(['operation', value])
        return { attempt: value, invocation: durableInvocation }
      },
      attest: async (value) => evidence.push(['attest', value]),
      preApplyGuard: async () => {
        if (guardError) throw guardError
        if (tamperPlan) writeFileSync(planPath, 'tampered plan', { mode: 0o600 })
      },
      postApplyGuard: async () => {
        if (postGuardError) throw postGuardError
      },
      emit: (event) => events.push(event)
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function applyConfig() {
  return {
    project: 'project',
    environment: 'production',
    terraformDir: 'infra/terraform',
    varFile: 'environments/production.tfvars',
    lockTimeout: '5m',
    fenceCommit: 'a'.repeat(40),
    cellIncarnation: '22222222-2222-4222-8222-222222222222',
    cell
  }
}

function durableAttempt(config = applyConfig(), overrides = {}) {
  const attemptId = '11111111-1111-4111-8111-111111111111'
  const varFile = join(config.terraformDir, config.varFile)
  const result = {
    attemptId,
    environment: config.environment,
    cellId: cell.cellId,
    cellIncarnation: config.cellIncarnation,
    migName: cell.migName,
    instanceGroup: cell.instanceGroup,
    generationIdentity: cell.generationIdentity,
    fenceCommit: config.fenceCommit,
    planSha256: createHash('sha256').update('private saved plan').digest('hex'),
    planObjectName: `terraform/state/relay-fence-plans/${config.environment}/${attemptId}.tfplan`,
    planObjectGeneration: '123456789',
    varFileSha256: createHash('sha256').update(readFileSync(varFile)).digest('hex'),
    terraformStateLineage: stateLineage,
    terraformStateSerial: 7,
    terraformStateObjectGeneration: '987654321',
    terraformStateObjectSha256: createHash('sha256')
      .update('pre-state object')
      .digest('hex'),
    requestReason: `orca-relay-fence/${attemptId}`,
    createdAt: 100,
    expiresAt: 3_600_100,
    ...overrides
  }
  if (result.applyStartedAt && result.applyInvocations === undefined) {
    const invocationId = '66666666-6666-4666-8666-666666666666'
    result.applyInvocations = [
      {
        invocationId,
        requestReason: `${result.requestReason}/${invocationId}`,
        startedAt: result.applyStartedAt,
        gceOperation: result.gceOperation
      }
    ]
  }
  return result
}

test('applies and attests the exact private saved plan', async () => {
  const harness = applyHarness()
  try {
    await runTerraformFenceApply(applyConfig(), harness.overrides)
    assert.deepEqual(
      harness.evidence.map(([event]) => event),
      ['prepare', 'bind', 'started', 'operation', 'attest', 'delete']
    )
    assert.equal(harness.calls.filter((args) => args.includes('apply')).length, 1)
    const planArgs = harness.calls.find((args) => args.includes('plan'))
    assert.equal(planArgs.includes('-refresh=false'), true)
    assert.equal(
      harness.applyEnvironments[0].GOOGLE_REQUEST_REASON,
      'orca-relay-fence/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111'
    )
    assert.equal(harness.events[0].event, 'terraform_cell_fenced')
    assert.equal(existsSync(harness.planPath()), false)
  } finally {
    harness.cleanup()
  }
})

test('rejects a malformed Terraform lineage before plan upload', async () => {
  const harness = applyHarness()
  const prepareAttempt = harness.overrides.prepareAttempt
  harness.overrides.prepareAttempt = async (value) => {
    const prepared = await prepareAttempt(value)
    return {
      attempt: {
        ...prepared.attempt,
        terraformStateLineage: 'not-a-terraform-lineage'
      }
    }
  }
  try {
    await assert.rejects(
      runTerraformFenceApply(applyConfig(), harness.overrides),
      /valid Terraform state identity/
    )
    assert.deepEqual(
      harness.evidence.map(([event]) => event),
      ['prepare']
    )
    assert.equal(harness.calls.filter((args) => args.includes('apply')).length, 0)
  } finally {
    harness.cleanup()
  }
})

test('recovers a successful fence after losing the apply response', async () => {
  const harness = applyHarness({ loseApplyResponse: true })
  try {
    await runTerraformFenceApply(applyConfig(), harness.overrides)
    assert.equal(harness.evidence.some(([event]) => event === 'attest'), true)
  } finally {
    harness.cleanup()
  }
})

test('does not start apply after a final pre-apply guard failure', async () => {
  const harness = applyHarness({ guardError: new Error('guard failed') })
  try {
    await assert.rejects(
      runTerraformFenceApply(applyConfig(), harness.overrides),
      /guard failed/
    )
    assert.equal(harness.calls.some((args) => args.includes('apply')), false)
    assert.deepEqual(harness.evidence.map(([event]) => event), ['prepare', 'bind'])
  } finally {
    harness.cleanup()
  }
})

test('rejects a saved plan whose digest changes before apply', async () => {
  const harness = applyHarness({ tamperPlan: true })
  try {
    await assert.rejects(
      runTerraformFenceApply(applyConfig(), harness.overrides),
      /digest changed/
    )
    assert.equal(harness.calls.some((args) => args.includes('apply')), false)
  } finally {
    harness.cleanup()
  }
})

test('requires recover-forward when an apply remains in progress', async () => {
  const harness = applyHarness({
    loseApplyResponse: true,
    progress: {
      stateTargetSize: 1,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'RUNNING',
      operationError: false,
      stateLineage,
      stateSerial: 7,
      gceOperation: 'operation-1'
    }
  })
  try {
    await assert.rejects(
      runTerraformFenceApply(applyConfig(), harness.overrides),
      /recover-forward required/
    )
    assert.notEqual(harness.evidence.at(-1)[0], 'attest')
  } finally {
    harness.cleanup()
  }
})

test('does not attest before retained topology and heartbeat guards pass', async () => {
  const harness = applyHarness({ postGuardError: new Error('topology mismatch') })
  try {
    await assert.rejects(
      runTerraformFenceApply(applyConfig(), harness.overrides),
      /topology mismatch/
    )
    assert.notEqual(harness.evidence.at(-1)[0], 'attest')
  } finally {
    harness.cleanup()
  }
})

test('aborts only when state and live GCE prove apply never began', async () => {
  let aborted = false
  let deleted = false
  const config = applyConfig()
  const attempt = durableAttempt(config)
  const common = {
    git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
    loadAttempt: async () => attempt,
    deletePlan: async () => {
      deleted = true
    }
  }
  await abortTerraformFenceBeforeApply(config, {
    ...common,
    assertCommittedFenceSet: async () => {},
    inspectProgress: async () => ({
      stateTargetSize: 1,
      liveTargetSize: 1,
      instanceCount: 1,
      operationStatus: 'ABSENT',
      stateLineage,
      stateSerial: 7
    }),
    abortAttempt: async () => {
      aborted = true
    }
  })
  assert.equal(aborted, true)
  assert.equal(deleted, true)
  await assert.rejects(
    abortTerraformFenceBeforeApply(config, {
      ...common,
      assertCommittedFenceSet: async () => {},
      inspectProgress: async () => ({
        stateTargetSize: 1,
        liveTargetSize: 0,
        instanceCount: 0,
        operationStatus: 'RUNNING',
        stateLineage,
        stateSerial: 7
      }),
      abortAttempt: async () => {}
    }),
    /cannot abort/
  )
})

test('supersedes only an older unuploaded fence attempt proven not started', async () => {
  const config = applyConfig()
  const attempt = durableAttempt(config, {
    fenceCommit: 'b'.repeat(40),
    planObjectGeneration: undefined
  })
  const events = []
  let aborted = false
  const common = {
    git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
    assertCommittedFenceSet: async () => {},
    loadAttempt: async () => attempt,
    resolvePlan: async () => ({ generation: null }),
    inspectProgress: async () => ({
      stateTargetSize: 1,
      liveTargetSize: 1,
      instanceCount: 1,
      operationStatus: 'ABSENT',
      stateLineage,
      stateSerial: 7
    }),
    abortAttempt: async () => {
      aborted = true
    },
    emit: (event) => events.push(event)
  }
  await abortSupersededTerraformFenceBeforeUpload(config, common)
  assert.equal(aborted, true)
  assert.deepEqual(events, [
    {
      event: 'terraform_fence_superseded_before_upload',
      cellId: cell.cellId,
      previousFenceCommit: 'b'.repeat(40),
      fenceCommit: config.fenceCommit
    }
  ])

  await assert.rejects(
    abortSupersededTerraformFenceBeforeUpload(config, {
      ...common,
      loadAttempt: async () => ({ ...attempt, planObjectGeneration: '123456789' })
    }),
    /after plan upload/
  )
  await assert.rejects(
    abortSupersededTerraformFenceBeforeUpload(config, {
      ...common,
      resolvePlan: async () => ({ generation: '123456789' })
    }),
    /with a saved plan/
  )
})

test('resumes and attests when state and live GCE are already zero', async () => {
  let attested
  const config = applyConfig()
  const attempt = durableAttempt(config, {
    applyStartedAt: 101,
    gceOperation: 'operation-1',
    completedAt: 120
  })
  let deleted = false
  await resumeTerraformFence(config, {
    git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
    assertCommittedFenceSet: async () => {},
    loadAttempt: async () => attempt,
    inspectProgress: async () => ({
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 8,
      gceOperation: 'operation-1'
    }),
    preApplyGuard: async () => {},
    postApplyGuard: async () => {},
    assertZeroDiff: async () => {},
    deletePlan: async () => {
      deleted = true
    },
    attest: async (value) => {
      attested = value
    }
  })
  assert.equal(attested.attemptId, attempt.attemptId)
  assert.equal(deleted, true)
})

function replayHarness({
  initialProgress,
  finalProgress,
  applyError = null,
  zeroDiffError = null,
  downloadedPlan = 'private saved plan',
  attemptOverrides = {}
} = {}) {
  const config = applyConfig()
  const root = mkdtempSync(join(tmpdir(), 'relay-fence-replay-test-'))
  const attempt = durableAttempt(config, {
    applyStartedAt: 101,
    ...attemptOverrides
  })
  const progress = [
    initialProgress ?? {
      stateTargetSize: 1,
      liveTargetSize: 1,
      instanceCount: 1,
      operationStatus: 'ABSENT',
      operationError: false,
      stateLineage,
      stateSerial: 7
    },
    finalProgress ?? {
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 8,
      gceOperation: 'operation-1'
    }
  ]
  let progressIndex = 0
  let applies = 0
  let downloads = 0
  let deleted = false
  let attested = false
  let zeroDiffChecks = 0
  return {
    config,
    attempt,
    applies: () => applies,
    downloads: () => downloads,
    deleted: () => deleted,
    attested: () => attested,
    zeroDiffChecks: () => zeroDiffChecks,
    deps: {
      git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
      tmpdir: () => root,
      assertCommittedFenceSet: async () => {},
      loadAttempt: async () => attempt,
      resolvePlan: async () => ({ generation: '123456789' }),
      bindPlan: async (value) => ({ attempt: value }),
      inspectProgress: async (_expected, currentAttempt) => {
        const value = progress[Math.min(progressIndex++, progress.length - 1)]
        if (!value.gceOperation || value.invocationOperations) return value
        const invocation = currentAttempt.applyInvocations?.at(-1)
        return {
          ...value,
          invocationOperations: invocation
            ? [
                {
                  ...invocation,
                  gceOperation: value.gceOperation,
                  operationStatus: value.operationStatus,
                  operationError: value.operationError,
                  auditBound: value.operationAuditBound
                }
              ]
            : []
        }
      },
      preApplyGuard: async () => {},
      postApplyGuard: async () => {},
      stateObjectBinding: async () => ({
        generation: attempt.terraformStateObjectGeneration,
        sha256: attempt.terraformStateObjectSha256,
        lineage: stateLineage,
        serial: 7
      }),
      assertZeroDiff: async () => {
        zeroDiffChecks++
        if (zeroDiffError) throw zeroDiffError
      },
      downloadPlan: async (value, path) => {
        assert.equal(
          value.planObjectGeneration,
          attempt.planObjectGeneration ?? '123456789'
        )
        downloads++
        writeFileSync(path, downloadedPlan, { mode: 0o600 })
      },
      terraform: (args) => {
        if (args.includes('show')) return JSON.stringify(plan())
        if (args.includes('apply')) {
          applies++
          if (applyError) throw applyError
        }
      },
      markOperation: async (value, invocation) => ({
        attempt: value,
        invocation: { ...invocation, gceOperation: value.gceOperation }
      }),
      markApplyStarted: async (value, invocation) => ({
        attempt: { ...value, applyStartedAt: value.applyStartedAt ?? 101 },
        invocation: { ...invocation, startedAt: 101 }
      }),
      attest: async () => {
        attested = true
      },
      deletePlan: async () => {
        deleted = true
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

test('replays the exact durable plan after crashing immediately after apply-start', async () => {
  const harness = replayHarness()
  try {
    await resumeTerraformFence(harness.config, harness.deps)
    assert.equal(harness.downloads(), 1)
    assert.equal(harness.applies(), 1)
    assert.equal(harness.attested(), true)
    assert.equal(harness.deleted(), true)
  } finally {
    harness.cleanup()
  }
})

test('recovers an uploaded plan whose generation was not bound before runner loss', async () => {
  const harness = replayHarness({
    attemptOverrides: {
      planObjectGeneration: undefined,
      applyStartedAt: undefined
    }
  })
  try {
    await resumeTerraformFence(harness.config, harness.deps)
    assert.equal(harness.downloads(), 1)
    assert.equal(harness.applies(), 1)
    assert.equal(harness.attested(), true)
  } finally {
    harness.cleanup()
  }
})

test('replays the exact durable plan to reconcile live zero with stale state', async () => {
  const harness = replayHarness({
    initialProgress: {
      stateTargetSize: 1,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 7,
      gceOperation: 'operation-1'
    }
  })
  try {
    await resumeTerraformFence(harness.config, harness.deps)
    assert.equal(harness.applies(), 1)
    assert.equal(harness.attested(), true)
  } finally {
    harness.cleanup()
  }
})

test('does not replay a stale saved plan after the first apply already persisted state', async () => {
  const harness = replayHarness({
    initialProgress: {
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 8,
      gceOperation: 'operation-1'
    }
  })
  try {
    await resumeTerraformFence(harness.config, harness.deps)
    assert.equal(harness.downloads(), 0)
    assert.equal(harness.applies(), 0)
    assert.equal(harness.deleted(), true)
    assert.equal(harness.zeroDiffChecks(), 1)
  } finally {
    harness.cleanup()
  }
})

test('replays when the recorded Terraform serial is unchanged even if refresh sees zero', async () => {
  const harness = replayHarness({
    initialProgress: {
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 7,
      gceOperation: 'operation-1'
    }
  })
  try {
    await resumeTerraformFence(harness.config, harness.deps)
    assert.equal(harness.applies(), 1)
    assert.equal(harness.zeroDiffChecks(), 1)
  } finally {
    harness.cleanup()
  }
})

test('freezes a serial-plus-one completion unless the reviewed targeted plan is zero diff', async () => {
  const harness = replayHarness({
    initialProgress: {
      stateTargetSize: 0,
      liveTargetSize: 0,
      instanceCount: 0,
      operationStatus: 'DONE',
      operationError: false,
      operationAuditBound: true,
      stateLineage,
      stateSerial: 8,
      gceOperation: 'operation-1'
    },
    zeroDiffError: new Error('not zero diff')
  })
  try {
    await assert.rejects(
      resumeTerraformFence(harness.config, harness.deps),
      /not zero diff/
    )
    assert.equal(harness.attested(), false)
    assert.equal(harness.deleted(), false)
  } finally {
    harness.cleanup()
  }
})

test('rejects saved-plan object generation and hash mismatches', async () => {
  const generation = replayHarness({
    attemptOverrides: { planObjectGeneration: '0' }
  })
  try {
    await assert.rejects(
      resumeTerraformFence(generation.config, generation.deps),
      /saved-plan generation/
    )
  } finally {
    generation.cleanup()
  }
  const digest = replayHarness({ downloadedPlan: 'tampered plan' })
  try {
    await assert.rejects(
      resumeTerraformFence(digest.config, digest.deps),
      /saved fence plan digest mismatch/
    )
    assert.equal(digest.applies(), 0)
    assert.equal(digest.deleted(), false)
  } finally {
    digest.cleanup()
  }
})

test('rejects Terraform state lineage or serial drift before replay', async () => {
  const harness = replayHarness({
    initialProgress: {
      stateTargetSize: 1,
      liveTargetSize: 1,
      instanceCount: 1,
      operationStatus: 'ABSENT',
      operationError: false,
      stateLineage,
      stateSerial: 8
    }
  })
  try {
    await assert.rejects(
      resumeTerraformFence(harness.config, harness.deps),
      /lineage or serial changed/
    )
    assert.equal(harness.downloads(), 0)
  } finally {
    harness.cleanup()
  }
})

test('keeps the durable plan when replay cannot acquire the Terraform lock', async () => {
  const notStarted = {
    stateTargetSize: 1,
    liveTargetSize: 1,
    instanceCount: 1,
    operationStatus: 'ABSENT',
    operationError: false,
    stateLineage,
    stateSerial: 7
  }
  const harness = replayHarness({
    initialProgress: notStarted,
    finalProgress: notStarted,
    applyError: new Error('state lock unavailable')
  })
  try {
    await assert.rejects(
      resumeTerraformFence(harness.config, harness.deps),
      /recover-forward required/
    )
    assert.equal(harness.deleted(), false)
    assert.equal(harness.attested(), false)
  } finally {
    harness.cleanup()
  }
})

test('deletes the exact object generation permanently and accepts confirmed absence', async () => {
  const config = applyConfig()
  const attempt = durableAttempt(config)
  let args
  await deleteTerraformFencePlan(
    config,
    {
      commandResult: (value) => {
        args = value
        return { status: 0, stderr: '' }
      }
    },
    attempt
  )
  assert.equal(
    args[2],
    `gs://project-terraform-state/${attempt.planObjectName}#${attempt.planObjectGeneration}`
  )
  await assert.doesNotReject(
    deleteTerraformFencePlan(
      config,
      { commandResult: () => ({ status: 1, stderr: '404 not found' }) },
      attempt
    )
  )
  await assert.rejects(
    deleteTerraformFencePlan(
      config,
      { commandResult: () => ({ status: 1, stderr: 'permission denied' }) },
      attempt
    ),
    /could not be deleted/
  )
})

test('binds a DONE resize operation to the exact post-start audit request reason', async () => {
  const config = applyConfig()
  const attempt = durableAttempt(config, { applyStartedAt: 101 })
  const targetLink =
    `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${cell.zone}/instanceGroupManagers/${cell.migName}`
  const terraform = (args) =>
    args.includes('state')
      ? JSON.stringify({ lineage: stateLineage, serial: 8 })
      : JSON.stringify(state(0))
  const gcloudJson = (args) => {
    if (args.includes('list-instances')) return []
    if (args.includes('managed')) return { targetSize: 0 }
    if (args[0] === 'compute') {
      return [
        {
          name: 'operation-1',
          insertTime: new Date(102).toISOString(),
          targetLink,
          operationType: 'compute.instanceGroupManagers.resize',
          status: 'DONE'
        }
      ]
    }
    return [
      {
        protoPayload: {
          requestMetadata: {
            requestAttributes: {
              reason: attempt.applyInvocations[0].requestReason
            }
          },
          resourceName:
            `projects/${config.project}/zones/${cell.zone}/instanceGroupManagers/${cell.migName}`,
          methodName: 'v1.compute.instanceGroupManagers.resize',
          request: { size: 0 },
          response: { name: 'operation-1' }
        }
      }
    ]
  }
  const progress = await inspectTerraformFenceProgress(
    config,
    { terraform, gcloudJson },
    attempt
  )
  assert.equal(progress.operationAuditBound, true)
  assert.equal(classifyTerraformFenceProgress(progress), 'complete')
  const unbound = await inspectTerraformFenceProgress(
    config,
    {
      terraform,
      gcloudJson: (args) => (args[0] === 'logging' ? [] : gcloudJson(args))
    },
    attempt
  )
  assert.throws(
    () => classifyTerraformFenceProgress(unbound),
    /ambiguous or unsafe/
  )
})

test('inspects an older completed fence through exact principal and operation evidence', async () => {
  const config = applyConfig()
  const attempt = durableAttempt(config, { applyStartedAt: 101 })
  const gceOperation = 'operation-1'
  const principalEmail = 'fence-broker@example.gserviceaccount.com'
  const targetLink =
    `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${cell.zone}/instanceGroupManagers/${cell.migName}`
  const resourceName =
    `projects/${config.project}/zones/${cell.zone}/instanceGroupManagers/${cell.migName}`
  const terraform = (args) =>
    args.includes('state')
      ? JSON.stringify({ lineage: stateLineage, serial: 8 })
      : JSON.stringify(state(0))
  const progress = await inspectCompletedTerraformFenceProgress(
    config,
    {
      terraform,
      gcloudJson: (args) => {
        if (args.includes('list-instances')) return []
        if (args.includes('managed')) {
          return { targetSize: 0, status: { isStable: true } }
        }
        if (args[0] === 'compute') {
          return [
            {
              name: gceOperation,
              insertTime: new Date(102).toISOString(),
              targetLink,
              operationType: 'compute.instanceGroupManagers.resize',
              status: 'DONE'
            }
          ]
        }
        return [
          {
            timestamp: new Date(103).toISOString(),
            protoPayload: {
              authenticationInfo: { principalEmail },
              resourceName,
              methodName: 'v1.compute.instanceGroupManagers.resize',
              request: { size: '0' },
              response: { name: gceOperation }
            }
          }
        ]
      }
    },
    attempt,
    { gceOperation, principalEmail }
  )
  assert.deepEqual(progress, {
    stateTargetSize: 0,
    stateLineage,
    stateSerial: 8,
    liveTargetSize: 0,
    instanceCount: 0,
    liveStable: true,
    operationStatus: 'DONE',
    operationError: false,
    gceOperation
  })
})

test('adopts only the pinned completed older attempt without replaying Terraform', async () => {
  const config = applyConfig()
  const root = mkdtempSync(join(tmpdir(), 'relay-fence-completed-recovery-test-'))
  const attempt = durableAttempt(config, {
    fenceCommit: 'b'.repeat(40),
    applyStartedAt: 101
  })
  const recovery = {
    attemptId: attempt.attemptId,
    fenceCommit: attempt.fenceCommit,
    gceOperation: 'operation-1',
    terraformStateSerial: 7,
    planObjectGeneration: attempt.planObjectGeneration,
    terraformStateObjectGeneration: '222222222',
    terraformStateObjectSha256: 'c'.repeat(64),
    principalEmail: 'fence-broker@example.gserviceaccount.com'
  }
  const events = []
  let applies = 0
  try {
    await recoverSupersededCompletedTerraformFence(
      config,
      {
        git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
        tmpdir: () => root,
        assertCommittedFenceSet: async () => {},
        loadAttempt: async () => attempt,
        resolvePlan: async () => ({ generation: attempt.planObjectGeneration }),
        stateObjectBinding: async () => ({
          generation: recovery.terraformStateObjectGeneration,
          sha256: recovery.terraformStateObjectSha256,
          lineage: stateLineage,
          serial: 8
        }),
        downloadPlan: async (_value, path) =>
          writeFileSync(path, 'private saved plan', { mode: 0o600 }),
        terraform: (args) => {
          if (args.includes('apply')) applies++
          if (args.includes('show')) return JSON.stringify(plan())
        },
        inspectCompletedProgress: async () => ({
          stateTargetSize: 0,
          stateLineage,
          stateSerial: 8,
          liveTargetSize: 0,
          instanceCount: 0,
          liveStable: true,
          operationStatus: 'DONE',
          operationError: false,
          gceOperation: recovery.gceOperation
        }),
        markOperation: async (value, invocation) => {
          events.push('operation')
          return { attempt: value, invocation }
        },
        assertZeroDiff: async () => events.push('zero-diff'),
        postApplyGuard: async () => events.push('post-apply'),
        attest: async () => events.push('attest'),
        deletePlan: async () => events.push('delete'),
        emit: () => events.push('emit')
      },
      recovery
    )
    assert.equal(applies, 0)
    assert.deepEqual(events, [
      'operation',
      'zero-diff',
      'post-apply',
      'attest',
      'delete',
      'emit'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('continues after an adopted fence was attested and its plan was deleted', async () => {
  const config = applyConfig()
  const root = mkdtempSync(join(tmpdir(), 'relay-fence-completed-retry-test-'))
  const gceOperation = 'operation-1'
  const attempt = durableAttempt(config, {
    fenceCommit: 'b'.repeat(40),
    applyStartedAt: 101,
    completedAt: 200,
    gceOperation
  })
  const recovery = {
    attemptId: attempt.attemptId,
    fenceCommit: attempt.fenceCommit,
    gceOperation,
    terraformStateSerial: 7,
    planObjectGeneration: attempt.planObjectGeneration,
    terraformStateObjectGeneration: '222222222',
    terraformStateObjectSha256: 'c'.repeat(64),
    principalEmail: 'fence-broker@example.gserviceaccount.com'
  }
  let attested = false
  try {
    await recoverSupersededCompletedTerraformFence(
      config,
      {
        git: (args) => (args.includes('rev-parse') ? `${config.fenceCommit}\n` : ''),
        tmpdir: () => root,
        assertCommittedFenceSet: async () => {},
        loadAttempt: async () => attempt,
        resolvePlan: async () => ({ generation: null }),
        stateObjectBinding: async () => ({
          generation: recovery.terraformStateObjectGeneration,
          sha256: recovery.terraformStateObjectSha256,
          lineage: stateLineage,
          serial: 8
        }),
        inspectCompletedProgress: async () => ({
          stateTargetSize: 0,
          stateLineage,
          stateSerial: 8,
          liveTargetSize: 0,
          instanceCount: 0,
          liveStable: true,
          operationStatus: 'DONE',
          operationError: false,
          gceOperation
        }),
        markOperation: async () => {
          throw new Error('must not rebind')
        },
        assertZeroDiff: async () => {},
        postApplyGuard: async () => {},
        attest: async () => {
          attested = true
        },
        downloadPlan: async () => {
          throw new Error('must not download a deleted plan')
        },
        deletePlan: async () => {
          throw new Error('must not delete an absent plan')
        }
      },
      recovery
    )
    assert.equal(attested, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
