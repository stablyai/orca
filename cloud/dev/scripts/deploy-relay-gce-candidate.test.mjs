import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertDeploymentConnectionCapacity,
  createAdminPost,
  deployment,
  parseArguments,
  runCandidateDeployment,
  selectDeployments,
  suppliedAdminIdentityToken,
  validateBackend,
  validateInstance,
  validateMig
} from './deploy-relay-gce-candidate.mjs'

const runtimeServiceAccount = 'orca-relay@example.iam.gserviceaccount.com'
const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

test('retries evacuation-status HTTP 500 without widening other admin retries', async () => {
  const events = []
  let calls = 0
  const adminPost = createAdminPost({}, {
    fetch: async () => {
      calls++
      return calls === 1
        ? new Response(JSON.stringify({ error: 'transient' }), { status: 500 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
    emit: (event) => events.push(event),
    wait: async () => {},
    random: () => 0
  }, 'token')
  assert.deepEqual(
    await adminPost('https://relay.example', '/v1/admin/evacuation-status', {}),
    { ok: true }
  )
  assert.equal(calls, 2)
  assert.deepEqual(events, [{
    event: 'candidate_admin_retry',
    path: '/v1/admin/evacuation-status',
    attempt: 1,
    reason: 'http_500'
  }])

  calls = 0
  await assert.rejects(
    createAdminPost({}, {
      fetch: async () => {
        calls++
        return new Response(JSON.stringify({ error: 'persistent' }), { status: 500 })
      },
      emit: () => {},
      wait: async () => {},
      random: () => 0
    }, 'token')('https://relay.example', '/v1/admin/runtime-status', {}),
    /runtime-status failed: persistent/
  )
  assert.equal(calls, 1)
})

test('verifies a 1,000-cap cell against both runtime and director telemetry', () => {
  const expected = deployment(
    {
      ...topology().target,
      connection_hard_cap: 1_000,
      connection_unobserved_bound: 60
    },
    'target'
  )
  const capacity = {
    hardCap: 1_000,
    controlRebindReserve: 100,
    ordinaryConnectionLimit: 900,
    unobservedBound: 60,
    normalAdmissionPause: 840
  }
  assert.doesNotThrow(() =>
    assertDeploymentConnectionCapacity(expected, capacity, {
      ...capacity,
      heartbeatFresh: true
    })
  )
  assert.throws(
    () =>
      assertDeploymentConnectionCapacity(expected, capacity, {
        ...capacity,
        hardCap: 600,
        heartbeatFresh: true
      }),
    /differs from Terraform/
  )
})

test('verifies a 3,000-cap regional cell with a 2,840 placement boundary', () => {
  const expected = deployment(
    {
      ...topology().target,
      connection_hard_cap: 3_000,
      connection_unobserved_bound: 60
    },
    'target'
  )
  const capacity = {
    hardCap: 3_000,
    controlRebindReserve: 100,
    ordinaryConnectionLimit: 2_900,
    unobservedBound: 60,
    normalAdmissionPause: 2_840
  }

  assert.doesNotThrow(() =>
    assertDeploymentConnectionCapacity(expected, capacity, {
      ...capacity,
      heartbeatFresh: true
    })
  )
})

function topology() {
  return {
    source: {
      origin: 'https://c1.relay.example.com',
      zone: 'us-central1-b',
      mig_name: 'relay-c1',
      instance_group: 'https://compute.example/instanceGroups/relay-c1',
      backend_name: 'relay-c1',
      backend_id: 'https://compute.example/backendServices/relay-c1',
      image: `us-central1-docker.pkg.dev/project/repo/relay@${digestA}`,
      capacity_requests: 4_000,
      initially_enabled: true
    },
    target: {
      origin: 'https://c2.relay.example.com',
      zone: 'us-central1-c',
      mig_name: 'relay-c2',
      instance_group: 'https://compute.example/instanceGroups/relay-c2',
      backend_name: 'relay-c2',
      backend_id: 'https://compute.example/backendServices/relay-c2',
      image: `us-central1-docker.pkg.dev/project/repo/relay@${digestB}`,
      capacity_requests: 4_000,
      initially_enabled: false
    }
  }
}

function withTopology(operation) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-gce-candidate-'))
  const file = join(directory, 'topology.json')
  writeFileSync(file, JSON.stringify(topology()))
  return Promise.resolve(operation(file)).finally(() => rmSync(directory, { recursive: true }))
}

function config(topologyFile, mode = 'preflight') {
  return {
    project: 'test-project',
    directorOrigin: 'https://relay.example.com',
    adminAudience: 'https://relay.example.com/v1/admin/drain',
    topologyFile,
    sourceCellId: 'source',
    targetCellId: 'target',
    runtimeServiceAccount,
    mode,
    batchSize: 100,
    drainGraceMs: 120_000,
    pollIntervalMs: 1,
    timeoutMs: 1_000
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function migrationResponse(body) {
  return response({
    registeredSourceActive: 0,
    registeredCompletable: 0,
    registeredTargetInactive: 0,
    expiredUnregistered: 0,
    repairableExpiredUnregistered: 0,
    abortableExpiredUnregistered: 0,
    blockedExpiredUnregistered: 0,
    blockedExpiredOnNewerTargetAssignment: 0,
    ...body
  })
}

function fakeCommand(args) {
  const name = args[args.indexOf('describe') + 1] ?? args[args.indexOf('list-instances') + 1]
  if (args.includes('list-instances')) {
    return [
      {
        instance: `https://compute.example/instances/${name}-vm`,
        instanceStatus: 'RUNNING',
        currentAction: 'NONE'
      }
    ]
  }
  if (args.includes('instance-groups')) {
    return {
      targetSize: 1,
      updatePolicy: {
        replacementMethod: 'RECREATE',
        maxSurge: { fixed: 0 },
        maxUnavailable: { fixed: 1 }
      }
    }
  }
  if (args.includes('instances')) {
    return {
      networkInterfaces: [{ networkIP: '10.42.0.2' }],
      serviceAccounts: [{ email: runtimeServiceAccount }]
    }
  }
  const cell = name === 'relay-c1' ? topology().source : topology().target
  return { protocol: 'HTTP', timeoutSec: 86_400, backends: [{ group: cell.instance_group }] }
}

function harness({
  failTargetEnable = false,
  failDrain = false,
  failAfterRegistration = false,
  failCompletionResponse = false,
  sourceEnabled = true,
  targetEnabled = false,
  targetAssignments = 0,
  migrationInProgress = 0,
  migrationTargetRegistered = 0,
  migrationTargetInactive = 0,
  transientCompletionFailures = 0,
  dormantSourceAssignments = 0,
  selectorGeneration = 0
} = {}) {
  const state = {
    source: {
      enabled: selectorGeneration > 0 ? false : sourceEnabled,
      assignments: 2,
      activityLeases: 2
    },
    target: {
      enabled: selectorGeneration > 0 ? true : targetEnabled,
      assignments: targetAssignments,
      activityLeases: targetAssignments
    }
  }
  const events = []
  const stateChanges = []
  let batch = 0
  let migrationCompleted = false
  let remainingTransientCompletionFailures = transientCompletionFailures
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/health' || parsed.pathname === '/ready') return response({ ok: true })
    const body = JSON.parse(options.body ?? '{}')
    if (parsed.pathname === '/v1/admin/runtime-status') {
      const target = parsed.origin.includes('c2.')
      return response({
        v: 1,
        role: 'cell',
        cellId: target ? 'target' : 'source',
        cellUrl: parsed.origin,
        imageDigest: target ? digestB : digestA
      })
    }
    if (parsed.pathname === '/v1/admin/admission-selector/status') {
      return response({
        v: 1,
        selector: {
          generation: selectorGeneration,
          attemptId: null,
          membership: {
            existingOnly:
              selectorGeneration > 0
                ? ['source']
                : Object.keys(state).filter((cellId) => !state[cellId].enabled),
            migrationOnly: selectorGeneration > 0 ? ['target'] : [],
            general:
              selectorGeneration > 0
                ? []
                : Object.keys(state).filter((cellId) => state[cellId].enabled)
          }
        },
        intent: null
      })
    }
    if (parsed.pathname === '/v1/admin/cell-status') {
      const cell = state[body.cellId]
      return response({
        v: 1,
        status: {
          cellId: body.cellId,
          cellUrl: topology()[body.cellId].origin,
          enabled: cell.enabled,
          admissionState:
            selectorGeneration > 0
              ? body.cellId === 'source'
                ? 'existing-only'
                : 'migration-only'
              : cell.enabled
              ? 'general'
              : 'existing-only',
          assignments: cell.assignments,
          activityLeases: cell.activityLeases,
          activityRequestUnits: cell.activityLeases,
          reservedRequests: cell.activityLeases,
          outgoingMigrations: 0,
          incomingMigrations: 0,
          runtime: {
            cellUrl: topology()[body.cellId].origin,
            ready: true,
            heartbeatFresh: true,
            observedRequests: cell.activityLeases
          }
        }
      })
    }
    if (parsed.pathname === '/v1/admin/evacuation-capacity') {
      return response({ sourceAssignments: 2, requiredTargetUnits: 4, availableTargetUnits: 4_000 })
    }
    if (parsed.pathname === '/v1/admin/cell-state') {
      stateChanges.push([body.cellId, body.enabled])
      if (failTargetEnable && body.cellId === 'target' && body.enabled) {
        return response({ error: 'injected_enable_failure' }, 409)
      }
      state[body.cellId].enabled = body.enabled
      return response({ ok: true })
    }
    if (parsed.pathname === '/v1/admin/evacuate-cell') {
      if (failAfterRegistration && batch > 0) {
        return response({ error: 'injected_batch_failure' }, 503)
      }
      const started = batch++ === 0 ? 2 : 0
      return response({ v: 1, started })
    }
    if (parsed.pathname === '/v1/admin/evacuation-status') {
      if (failAfterRegistration) {
        return migrationResponse({
          v: 1,
          inProgress: 2,
          targetRegistered: 1,
          registeredSourceActive: 1,
          completed: 0,
          blocked: 1
        })
      }
      if (failDrain) {
        return migrationResponse({
          v: 1,
          inProgress: 2,
          targetRegistered: 0,
          completed: 0,
          blocked: 0
        })
      }
      if (body.completeReady) {
        state.source.assignments = dormantSourceAssignments
        state.source.activityLeases = 0
        state.target.assignments = 2
        state.target.activityLeases = 2
        if (remainingTransientCompletionFailures > 0) {
          remainingTransientCompletionFailures--
          throw new TypeError('injected transient fetch failure')
        }
        if (migrationTargetInactive > 0) {
          return migrationResponse({
            v: 1,
            inProgress: migrationTargetInactive,
            targetRegistered: migrationTargetInactive,
            registeredTargetInactive: migrationTargetInactive,
            completed: 0,
            blocked: migrationTargetInactive
          })
        }
        migrationCompleted = true
        if (failCompletionResponse) {
          return response({ error: 'injected_completion_response_failure' }, 503)
        }
        return migrationResponse({
          v: 1,
          inProgress: 0,
          targetRegistered: 0,
          completed: 2,
          blocked: 0
        })
      }
      if (migrationCompleted) {
        return migrationResponse({
          v: 1,
          inProgress: 0,
          targetRegistered: 0,
          completed: 0,
          blocked: 0
        })
      }
      if (batch === 0) {
        return migrationResponse({
          v: 1,
          inProgress: migrationInProgress,
          targetRegistered: migrationTargetRegistered,
          completed: 0,
          blocked: 0
        })
      }
      return migrationResponse({
        v: 1,
        inProgress: 2,
        targetRegistered: 2,
        registeredCompletable: 2,
        completed: 0,
        blocked: 0
      })
    }
    if (parsed.pathname === '/v1/admin/drain') {
      return failDrain ? response({ error: 'injected_drain_failure' }, 503) : response({ ok: true })
    }
    return response({ error: 'unexpected_request' }, 500)
  }
  return {
    overrides: {
      commandJson: fakeCommand,
      identityToken: () => 'secret-token-never-emitted',
      fetch,
      emit: (event) => events.push(event),
      wait: async () => undefined,
      random: () => 0
    },
    events,
    stateChanges,
    state
  }
}

test('requires explicit dry-run/execute inputs and a distinct disabled candidate', () => {
  assert.throws(() => parseArguments([]), /missing --project/)
  assert.throws(
    () =>
      parseArguments([
        '--project',
        'project',
        '--director-origin',
        'https://relay.example.com',
        '--admin-audience',
        'https://relay.example.com/not-drain',
        '--topology-file',
        'topology.json',
        '--source-cell-id',
        'source',
        '--target-cell-id',
        'target',
        '--runtime-service-account',
        runtimeServiceAccount,
        '--mode',
        'preflight'
      ]),
    /director drain URL/
  )
  assert.throws(() => selectDeployments(topology(), 'source', 'source'), /must differ/)
  const overlapping = topology()
  overlapping.target.backend_id = overlapping.source.backend_id
  assert.throws(() => selectDeployments(overlapping, 'source', 'target'), /backendId overlap/)
  const enabled = topology()
  enabled.target.initially_enabled = true
  assert.throws(() => selectDeployments(enabled, 'source', 'target'), /initially disabled/)
})

test('accepts only a bounded JWT-shaped supplied admin identity token', () => {
  assert.equal(suppliedAdminIdentityToken({}), null)
  assert.equal(suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' }), 'aaa.bbb.ccc')
  assert.throws(() => suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: '' }))
  assert.throws(() => suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: 'not-a-jwt' }))
  assert.throws(() =>
    suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: `aaa.${'b'.repeat(8_190)}.ccc` })
  )
})

test('rejects unsafe fixed-one topology, public IPs, and backend overlap', () => {
  const expected = selectDeployments(topology(), 'source', 'target').target
  assert.throws(() => validateMig({ targetSize: 2 }, [], expected), /fixed-one/)
  assert.throws(
    () =>
      validateInstance(
        {
          networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.1' }] }],
          serviceAccounts: [{ email: runtimeServiceAccount }]
        },
        expected,
        runtimeServiceAccount
      ),
    /public IP/
  )
  assert.throws(
    () => validateBackend({ protocol: 'HTTP', timeoutSec: 86_400, backends: [] }, expected),
    /topology mismatch/
  )
})

test('preflights exact served digests and survivor headroom without mutating admission', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness()
    await runCandidateDeployment(config(file), overrides)
    assert.deepEqual(stateChanges, [])
    assert.equal(events[0].event, 'candidate_preflight')
    assert.equal(events[0].targetDigest, digestB)
    assert.equal(JSON.stringify(events).includes('secret-token'), false)
  })
})

test('audits a partially committed migration without changing admission or completing rows', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: false,
      targetEnabled: true,
      targetAssignments: 1,
      migrationInProgress: 2,
      migrationTargetRegistered: 2
    })
    await runCandidateDeployment(config(file, 'audit'), overrides)
    assert.deepEqual(stateChanges, [])
    assert.deepEqual(events, [
      {
        event: 'candidate_audit',
        source: {
          cellId: 'source',
          enabled: false,
          assignments: 2,
          activityLeases: 2,
          activityRequestUnits: 2,
          reservedRequests: 2,
          outgoingMigrations: 0,
          incomingMigrations: 0,
          runtimeReady: true,
          heartbeatFresh: true,
          observedRequests: 2
        },
        target: {
          cellId: 'target',
          enabled: true,
          assignments: 1,
          activityLeases: 1,
          activityRequestUnits: 1,
          reservedRequests: 1,
          outgoingMigrations: 0,
          incomingMigrations: 0,
          runtimeReady: true,
          heartbeatFresh: true,
          observedRequests: 1
        },
        migration: {
          v: 1,
          inProgress: 2,
          targetRegistered: 2,
          registeredSourceActive: 0,
          registeredCompletable: 0,
          registeredTargetInactive: 0,
          completed: 0,
          blocked: 0,
          expiredUnregistered: 0,
          repairableExpiredUnregistered: 0,
          abortableExpiredUnregistered: 0,
          blockedExpiredUnregistered: 0,
          blockedExpiredOnNewerTargetAssignment: 0
        }
      }
    ])
  })
})

test('preflights with source admission disabled but still refuses execution', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({ sourceEnabled: false })
    await runCandidateDeployment(config(file), overrides)
    assert.deepEqual(stateChanges, [])
    assert.equal(events.at(-1).event, 'candidate_preflight')
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), overrides),
      /source cell is not enabled/
    )
    assert.deepEqual(stateChanges, [])
  })
})

test('explicitly resets only an empty declared candidate to disabled admission', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: false,
      targetEnabled: true
    })
    await runCandidateDeployment(config(file, 'reset-empty-candidate'), overrides)
    assert.deepEqual(stateChanges, [['target', false]])
    assert.deepEqual(events.at(-1), {
      event: 'candidate_admission_reset',
      targetCellId: 'target',
      changed: true
    })
  })
})

test('refuses to reset candidate admission while it owns durable activity', async () => {
  await withTopology(async (file) => {
    const { overrides, stateChanges } = harness({ targetEnabled: true, targetAssignments: 1 })
    await assert.rejects(
      runCandidateDeployment(config(file, 'reset-empty-candidate'), overrides),
      /requires zero durable activity/
    )
    assert.deepEqual(stateChanges, [])
  })
})

test('disables only new admission while preserving durable candidate activity', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      targetEnabled: true,
      targetAssignments: 1
    })
    await runCandidateDeployment(config(file, 'disable-cell'), overrides)
    assert.deepEqual(stateChanges, [['target', false]])
    assert.deepEqual(events.at(-1), {
      event: 'cell_admission_disabled',
      targetCellId: 'target',
      changed: true,
      assignments: 1,
      activityLeases: 1,
      reservedRequests: 1,
      outgoingMigrations: 0,
      incomingMigrations: 0
    })
  })
})

test('explicitly enables only an empty preflighted cell for admission', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({ sourceEnabled: false })
    await runCandidateDeployment(config(file, 'enable-empty-cell'), overrides)
    assert.deepEqual(stateChanges, [['target', true]])
    assert.equal(events.at(-2).event, 'candidate_preflight')
    assert.deepEqual(events.at(-1), {
      event: 'cell_admission_enabled',
      targetCellId: 'target',
      changed: true
    })
  })
})

test('refuses to enable cell admission while it owns durable activity', async () => {
  await withTopology(async (file) => {
    const { overrides, stateChanges } = harness({ targetAssignments: 1 })
    await assert.rejects(
      runCandidateDeployment(config(file, 'enable-empty-cell'), overrides),
      /requires zero durable activity/
    )
    assert.deepEqual(stateChanges, [])
  })
})

test('executes target-first evacuation and verifies aggregate drained counts', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness()
    await runCandidateDeployment(config(file, 'execute'), overrides)
    assert.deepEqual(stateChanges.slice(0, 2), [
      ['source', false],
      ['target', true]
    ])
    assert.equal(events.at(-1).event, 'candidate_complete')
    assert.equal(events.at(-1).targetAssignments, 2)
  })
})

test('executes within selector membership without legacy admission writes', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ selectorGeneration: 1 })
    await runCandidateDeployment(config(file, 'execute'), testHarness.overrides)
    assert.deepEqual(testHarness.stateChanges, [])
    assert.equal(testHarness.state.source.enabled, false)
    assert.equal(testHarness.state.target.enabled, true)
  })
})

test('never restores legacy general admission after selector-era failure', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorGeneration: 1,
      failAfterRegistration: true
    })
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), testHarness.overrides),
      /injected_batch_failure/
    )
    assert.deepEqual(testHarness.stateChanges, [])
    assert.equal(testHarness.state.source.enabled, false)
  })
})

test('continues a partial evacuation without resetting target admission', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: true,
      targetEnabled: true,
      targetAssignments: 1,
      migrationInProgress: 1,
      migrationTargetRegistered: 1
    })
    await runCandidateDeployment(config(file, 'continue-evacuation'), overrides)
    assert.deepEqual(stateChanges, [['source', false]])
    assert.equal(events.at(-1).event, 'candidate_complete')
  })
})

test('refuses continued evacuation unless target admission is already enabled', async () => {
  await withTopology(async (file) => {
    const { overrides, stateChanges } = harness()
    await assert.rejects(
      runCandidateDeployment(config(file, 'continue-evacuation'), overrides),
      /requires enabled target/
    )
    assert.deepEqual(stateChanges, [])
  })
})

test('preserves partial target admission when continued batching fails', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      failAfterRegistration: true,
      sourceEnabled: true,
      targetEnabled: true,
      targetAssignments: 1,
      migrationInProgress: 1,
      migrationTargetRegistered: 1
    })
    await assert.rejects(
      runCandidateDeployment(config(file, 'continue-evacuation'), overrides),
      /injected_batch_failure/
    )
    assert.deepEqual(stateChanges, [['source', false]])
    assert.equal(events.at(-1).event, 'candidate_forward_recovery_required')
  })
})

test('resumes only a committed forward migration and preserves dormant source assignments', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: false,
      targetEnabled: true,
      migrationInProgress: 2,
      migrationTargetRegistered: 2,
      dormantSourceAssignments: 7
    })
    await runCandidateDeployment(config(file, 'recover-forward'), overrides)
    assert.deepEqual(stateChanges, [])
    assert.deepEqual(events.at(-1), {
      event: 'candidate_forward_recovered',
      sourceCellId: 'source',
      targetCellId: 'target',
      dormantSourceAssignments: 7,
      targetAssignments: 2,
      targetActivityLeases: 2,
      targetReservedRequests: 2
    })
  })
})

test('retries a transient idempotent completion request without reversing admission', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: false,
      targetEnabled: true,
      migrationInProgress: 2,
      migrationTargetRegistered: 2,
      transientCompletionFailures: 1
    })
    await runCandidateDeployment(config(file, 'recover-forward'), overrides)
    assert.deepEqual(stateChanges, [])
    assert.deepEqual(
      events.filter(({ event }) => event === 'candidate_admin_retry'),
      [
        {
          event: 'candidate_admin_retry',
          path: '/v1/admin/evacuation-status',
          attempt: 1,
          reason: 'transport'
        }
      ]
    )
    assert.equal(events.at(-1).event, 'candidate_forward_recovered')
  })
})

test('stops forward recovery promptly when only registered offline targets remain', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({
      sourceEnabled: false,
      targetEnabled: true,
      migrationInProgress: 2,
      migrationTargetRegistered: 2,
      migrationTargetInactive: 2
    })
    await assert.rejects(
      runCandidateDeployment(config(file, 'recover-forward'), overrides),
      /pending for inactive target controls/
    )
    assert.deepEqual(stateChanges, [])
    assert.deepEqual(events.at(-1), {
      event: 'candidate_forward_pending',
      sourceCellId: 'source',
      targetCellId: 'target',
      inProgress: 2,
      registeredSourceActive: 0,
      registeredCompletable: 0,
      registeredTargetInactive: 2
    })
  })
})

test('refuses forward recovery unless source and target admission match committed direction', async () => {
  await withTopology(async (file) => {
    const { overrides, stateChanges } = harness()
    await assert.rejects(
      runCandidateDeployment(config(file, 'recover-forward'), overrides),
      /requires disabled source and enabled target/
    )
    assert.deepEqual(stateChanges, [])
  })
})

test('re-enables an intact source when candidate admission fails before migration', async () => {
  await withTopology(async (file) => {
    const { overrides, stateChanges } = harness({ failTargetEnable: true })
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), overrides),
      /injected_enable_failure/
    )
    assert.deepEqual(stateChanges, [
      ['source', false],
      ['target', true],
      ['source', true],
      ['target', false]
    ])
  })
})

test('re-enables the source and waits for lease rollback when no target registered', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({ failDrain: true })
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), overrides),
      /injected_drain_failure/
    )
    assert.deepEqual(stateChanges.slice(-1), [['source', true]])
    assert.equal(events.at(-1).event, 'candidate_rollback_waiting_for_lease_expiry')
  })
})

test('preserves both routes for forward recovery after a target registration', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({ failAfterRegistration: true })
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), overrides),
      /injected_batch_failure/
    )
    assert.deepEqual(stateChanges, [
      ['source', false],
      ['target', true]
    ])
    assert.equal(events.at(-1).event, 'candidate_forward_recovery_required')
    assert.equal(events.at(-1).targetRegistered, 1)
  })
})

test('does not reverse admission after completion commits but its response is lost', async () => {
  await withTopology(async (file) => {
    const { overrides, events, stateChanges } = harness({ failCompletionResponse: true })
    await assert.rejects(
      runCandidateDeployment(config(file, 'execute'), overrides),
      /injected_completion_response_failure/
    )
    assert.deepEqual(stateChanges, [
      ['source', false],
      ['target', true]
    ])
    assert.equal(events.at(-1).event, 'candidate_forward_recovery_required')
    assert.equal(events.at(-1).targetRegistered, 0)
  })
})
