import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RELAY_GITHUB_REPOSITORY, relayWorkflowPath } from './relay-repository.mjs'
import {
  buildC27CanaryEvidence,
  buildStagingEvidence,
  verifyRolloutEvidence
} from './relay-asia-rollout-evidence.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const commitSha = 'b'.repeat(40)
const repository = RELAY_GITHUB_REPOSITORY
const start = new Date('2026-08-13T12:00:00.000Z')
const end = new Date(start.valueOf() + 15 * 60_000)
const canaryEnd = new Date(start.valueOf() + 5 * 60_000)

function sourceInput(overrides = {}) {
  return {
    repository, runId: 123, runAttempt: 2, commitSha, imageDigest: digest,
    selectorGeneration: 9, ...overrides
  }
}

function metricLog(timestamp, role, cellId, overrides = {}) {
  return {
    timestamp: timestamp.toISOString(),
    resource: { labels: role === 'director' ? { instance_id: 'director-1' } : {} },
    jsonPayload: {
      role, cellId, region: role === 'cell' ? 'asia-east2' : 'us-central1',
      controls: role === 'cell' ? 2_840 : 0,
      splices: role === 'cell' ? 120 : 0,
      selectedRegionsDelta: role === 'director' ? { 'asia-east2': 1 } : {},
      regionFallbacksDelta: {}, unavailableRegionsDelta: {}, sqlFailuresDelta: 0,
      databasePoolWaiting: 0, databasePoolWaitersMax: 0, databasePoolWaitMsMax: 0,
      ...overrides
    }
  }
}

function completeLogs(cellId = 'production-gce-c27', windowEnd = end) {
  const samples = (windowEnd.valueOf() - start.valueOf()) / 60_000 + 1
  return Array.from({ length: samples }, (_, minute) => {
    const timestamp = new Date(start.valueOf() + minute * 60_000)
    return [
      metricLog(timestamp, 'director', 'production-director'),
      metricLog(timestamp, 'cell', cellId)
    ]
  }).flat()
}

function cloudSql(max = 319, windowEnd = end) {
  const samples = (windowEnd.valueOf() - start.valueOf()) / 60_000
  return {
    timeSeries: [{
      points: Array.from({ length: samples }, (_, minute) => ({
        interval: { endTime: new Date(start.valueOf() + (minute + 1) * 60_000).toISOString() },
        value: { int64Value: String(minute === samples - 1 ? max : 300) }
      }))
    }]
  }
}

function loadReport({
  controls, shardIndex, splices = 0, slow = 0, wedged = 0,
  launch = false
}) {
  return {
    event: 'relay_load_complete', controls, shardCount: 4, shardIndex,
    configuredRampSeconds: 180, configuredSteadySeconds: 210, requiredLeaseHorizons: 2,
    configuredSpliceHoldSeconds: 210,
    configuredSplices: splices, configuredSlowReaderSplices: slow,
    configuredWedgedReaderSplices: wedged,
    peakActive: controls, steadyMinimumActive: controls,
    connectionFailures: 0, rampConnectionFailures: 0, steadyConnectionFailures: 0,
    transitionConnectionFailures: 0, unexpectedCloses: 0, protocolErrors: 0,
    refreshErrors: 0, socketErrors: 0, failedSplices: 0,
    regionalFallbacksProved: 0,
    oldClientUsFirstProved: launch ? 1 : 0,
    stickyAssignmentProved: launch ? 1 : 0,
    requestUnitInvitesOpened: 0,
    requestUnitPrincipalCount: 0,
    relayAsiaLoadPrincipalCount: 32,
    requestUnitOverflowReason: null,
    requestUnitCleanupProved: 0,
    phaseBarrierPassed: true,
    rebindProbesOpened: launch ? 2 : 0,
    rebindOverflowReason: null,
    peakActiveSplices: splices, completedSplices: splices - wedged,
    slowReaderSplicesCompleted: slow, wedgedReaderSplicesClosed: wedged,
    readerQueuedBytesPeak: slow > 0 ? 1_024 : 0,
    generatorCpuPercent: 25, generatorEventLoopP99Ms: 20, generatorRssGrowthMiB: 10,
    readerQueueEvidence: slow > 0 ? [{
      origin: 'https://c4.relay-staging.onorca.dev',
      baselineBytes: 128,
      peakBytes: 1_152,
      increaseBytes: 1_024
    }] : [],
    shutdownEvidence: {
      peerShutdowns: controls, activeControls: 0, activeSplices: 0, reconnectTimers: 0
    }
  }
}

function stagingInput(overrides = {}) {
  const logs = completeLogs('staging-gce-c4')
  logs[0].jsonPayload.regionFallbacksDelta = { 'us-central1': 1 }
  return {
    ...sourceInput({ selectorGeneration: 4 }),
    startedAt: start.toISOString(), endedAt: end.toISOString(),
    launchReport: Array.from({ length: 4 }, (_, shardIndex) => loadReport({
      controls: 5, shardIndex, splices: 5, launch: shardIndex === 0,
      slow: shardIndex === 0 ? 4 : 0, wedged: shardIndex === 0 ? 1 : 0
    })),
    logs, cloudSql: cloudSql(), ...overrides
  }
}

function canaryInput(overrides = {}) {
  const load = loadReport({ controls: 1, shardIndex: 0, splices: 1 })
  Object.assign(load, {
    shardCount: 1,
    configuredSteadySeconds: 300,
    configuredSpliceHoldSeconds: 60,
    relayAsiaLoadPrincipalCount: 1
  })
  return {
    ...sourceInput(), startedAt: start.toISOString(), endedAt: canaryEnd.toISOString(),
    loadReport: load,
    logs: completeLogs('production-gce-c27', canaryEnd), cloudSql: cloudSql(319, canaryEnd),
    ...overrides
  }
}

function workflowRun(evidence, overrides = {}) {
  return {
    id: evidence.source.runId, run_attempt: evidence.source.runAttempt,
    conclusion: 'success', event: 'workflow_dispatch', head_branch: 'main',
    head_sha: evidence.source.commitSha,
    repository: { full_name: evidence.source.repository }, path: evidence.source.workflow,
    ...overrides
  }
}

function verifyExpected(kind, overrides = {}) {
  const staging = kind === 'staging-asia-readiness'
  return {
    kind, repository,
    workflow: staging
      ? relayWorkflowPath('prove-relay-asia-staging.yml')
      : relayWorkflowPath('operate-relay-asia-admission.yml'),
    environment: staging ? 'staging' : 'production', commitSha, imageDigest: digest,
    cellIds: [staging ? 'staging-gce-c4' : 'production-gce-c27'],
    now: new Date(end.valueOf() + 60_000).toISOString(), ...overrides
  }
}

test('accepts the exact sharded staging load, telemetry, and provenance proof', () => {
  const evidence = buildStagingEvidence(stagingInput())
  assert.equal(evidence.load.launch.controls, 20)
  assert.equal(evidence.load.launch.peakActiveSplices, 20)
  assert.equal(evidence.load.launch.readerQueueEvidence.length, 1)
  assert.equal(verifyRolloutEvidence(
    evidence, workflowRun(evidence), verifyExpected('staging-asia-readiness')
  ), evidence)
})

test('ignores unrelated legacy cell metrics outside the Asia proof', () => {
  const input = stagingInput()
  const legacy = metricLog(start, 'cell', 'staging-gce-c1', {
    region: undefined,
    sqlFailuresDelta: 1
  })
  delete legacy.jsonPayload.databasePoolWaiting
  delete legacy.jsonPayload.databasePoolWaitersMax
  delete legacy.jsonPayload.databasePoolWaitMsMax
  input.logs.push(legacy)

  assert.equal(buildStagingEvidence(input).metrics.relaySqlFailures, 0)
})

test('accepts bounded transient pool waits without a sampled queue', () => {
  const input = stagingInput()
  input.logs[0].jsonPayload.databasePoolWaitersMax = 4
  input.logs[0].jsonPayload.databasePoolWaitMsMax = 50

  const metrics = buildStagingEvidence(input).metrics
  assert.equal(metrics.databasePoolWaitingMax, 0)
  assert.equal(metrics.databasePoolWaitersMax, 4)
  assert.equal(metrics.databasePoolWaitMsMax, 50)
})

test('requires exactly the intentional sticky-assignment fallback in staging', () => {
  const missing = stagingInput()
  missing.logs[0].jsonPayload.regionFallbacksDelta = {}
  assert.throws(() => buildStagingEvidence(missing), /intentional probes/)

  const extra = stagingInput()
  extra.logs[2].jsonPayload.regionFallbacksDelta = { 'asia-east2': 1 }
  assert.throws(() => buildStagingEvidence(extra), /intentional probes/)

  const substituted = stagingInput()
  substituted.logs[0].jsonPayload.regionFallbacksDelta = { 'asia-east2': 1 }
  assert.throws(() => buildStagingEvidence(substituted), /intentional probes/)
})

test('accepts the wedged splice outside the sustained non-wedged peak', () => {
  const input = stagingInput()
  input.launchReport[0].peakActiveSplices = 4
  input.logs.filter((entry) => entry.jsonPayload.role === 'cell')
    .forEach((entry) => { entry.jsonPayload.splices = 19 })
  const evidence = buildStagingEvidence(input)
  assert.equal(evidence.load.launch.peakActiveSplices, 19)

  input.launchReport[0].peakActiveSplices = 3
  assert.throws(() => buildStagingEvidence(input), /mixed load evidence/)
})

test('rejects staging evidence with incomplete load or cleanup', () => {
  const input = stagingInput()
  input.launchReport[0].steadyMinimumActive--
  assert.throws(() => buildStagingEvidence(input), /required controls/)
  const cleanup = stagingInput()
  cleanup.launchReport[0].shutdownEvidence.activeControls = 1
  assert.throws(() => buildStagingEvidence(cleanup), /cleanup/)
  const nonCausal = stagingInput()
  nonCausal.launchReport[0].readerQueueEvidence[0].increaseBytes = 0
  assert.throws(() => buildStagingEvidence(nonCausal), /not causal/)
  const multipleOwners = stagingInput()
  multipleOwners.launchReport[0].configuredSlowReaderSplices--
  multipleOwners.launchReport[0].slowReaderSplicesCompleted--
  multipleOwners.launchReport[1] = loadReport({
    controls: 5, shardIndex: 1, splices: 5, slow: 1
  })
  assert.throws(() => buildStagingEvidence(multipleOwners), /one causal owner/)
  const overloaded = stagingInput()
  overloaded.launchReport[0].generatorCpuPercent = 80
  assert.throws(() => buildStagingEvidence(overloaded), /insufficient headroom/)
  const missingLaunchProof = stagingInput()
  missingLaunchProof.launchReport[0].rebindProbesOpened = 0
  assert.throws(() => buildStagingEvidence(missingLaunchProof), /launch-path/)
  const offTarget = stagingInput()
  offTarget.logs.filter((entry) => entry.jsonPayload.role === 'cell')
    .forEach((entry) => { entry.jsonPayload.controls = 19 })
  assert.throws(() => buildStagingEvidence(offTarget), /did not reach C4/)
})

test('rejects staging evidence with a shortened splice hold', () => {
  const input = stagingInput()
  input.launchReport[0].configuredSpliceHoldSeconds = 60
  assert.throws(() => buildStagingEvidence(input), /load profile does not match/)
})

for (const [label, value] of [['missing', undefined], ['malformed', 'invalid']]) {
  test(`rejects staging evidence with a ${label} splice hold`, () => {
    const input = stagingInput()
    input.launchReport[0].configuredSpliceHoldSeconds = value
    assert.throws(() => buildStagingEvidence(input), /staging splice hold seconds is invalid/)
  })
}

for (const [label, mutate, message] of [
  ['phase barrier', (input) => { input.launchReport[0].phaseBarrierPassed = false }, /profile/],
  ['old-client routing', (input) => { input.launchReport[0].oldClientUsFirstProved = 0 }, /launch-path/],
  ['sticky routing', (input) => { input.launchReport[0].stickyAssignmentProved = 0 }, /launch-path/]
]) {
  test(`rejects staging evidence without ${label} proof`, () => {
    const input = stagingInput()
    mutate(input)
    assert.throws(() => buildStagingEvidence(input), message)
  })
}

test('rejects staging evidence from a non-canonical repository', () => {
  assert.throws(() => buildStagingEvidence(stagingInput({ repository: 'fork/orca-cloud' })), /repository/)
})

test('rejects mismatched staging provenance, digest, topology, or age', () => {
  const evidence = buildStagingEvidence(stagingInput())
  const expected = verifyExpected('staging-asia-readiness')
  assert.throws(() => verifyRolloutEvidence(evidence, workflowRun(evidence, {
    head_sha: 'c'.repeat(40)
  }), expected), /provenance/)
  assert.throws(() => verifyRolloutEvidence(evidence, workflowRun(evidence), {
    ...expected, commitSha: 'c'.repeat(40)
  }), /provenance/)
  assert.throws(() => verifyRolloutEvidence(evidence, workflowRun(evidence), {
    ...expected, imageDigest: `sha256:${'c'.repeat(64)}`
  }), /image digest/)
  assert.throws(() => verifyRolloutEvidence({
    ...evidence, topology: { ...evidence.topology, cellIds: ['staging-gce-c3'] }
  }, workflowRun(evidence), expected), /topology/)
  assert.throws(() => verifyRolloutEvidence(evidence, workflowRun(evidence), {
    ...expected, now: new Date(end.valueOf() + 25 * 60 * 60_000).toISOString()
  }), /stale/)
})

test('builds and verifies a passing continuous 5-minute C27 canary', () => {
  const evidence = buildC27CanaryEvidence(canaryInput())
  assert.equal(evidence.load.completedSplices, 1)
  assert.equal(evidence.metrics.asiaSelections, 6)
  assert.equal(evidence.metrics.cloudSqlBackendsMax, 319)
  assert.equal(verifyRolloutEvidence(
    evidence, workflowRun(evidence),
    verifyExpected('production-c27-canary', { selectorGeneration: 9 })
  ), evidence)
})

test('rejects short, sparse, or unrelated-cell-only C27 coverage', () => {
  assert.throws(() => buildC27CanaryEvidence(canaryInput({
    endedAt: new Date(canaryEnd.valueOf() - 1).toISOString()
  })), /shorter than 5 minutes/)
  const sparse = completeLogs('production-gce-c27', canaryEnd).filter((entry) =>
    entry.timestamp === start.toISOString() || entry.timestamp === canaryEnd.toISOString()
  )
  assert.throws(() => buildC27CanaryEvidence(canaryInput({ logs: sparse })), /sampling gap/)
  assert.throws(() => buildC27CanaryEvidence(canaryInput({
    logs: completeLogs('production-gce-c26', canaryEnd)
  })), /production-gce-c27 metrics has no samples/)
})

test('rejects a C27 canary without a real control and splice', () => {
  const input = canaryInput()
  input.loadReport.completedSplices = 0
  assert.throws(() => buildC27CanaryEvidence(input), /did not match/)
  const shortHold = canaryInput()
  shortHold.loadReport.configuredSpliceHoldSeconds = 59
  assert.throws(() => buildC27CanaryEvidence(shortHold), /did not match/)
})

for (const [label, mutation, message] of [
  ['Asia selections', (input) => input.logs.forEach((entry) => { entry.jsonPayload.selectedRegionsDelta = {} }), /no Asia selections/],
  ['region fallbacks', (input) => { input.logs[0].jsonPayload.regionFallbacksDelta = { 'asia-east2': 1 } }, /regionFallbacks/],
  ['unavailable regions', (input) => { input.logs[0].jsonPayload.unavailableRegionsDelta = { 'asia-east2': 1 } }, /unavailableRegions/],
  ['Relay SQL failures', (input) => { input.logs[0].jsonPayload.sqlFailuresDelta = 1 }, /relaySqlFailures/],
  ['pool waiting', (input) => { input.logs[0].jsonPayload.databasePoolWaiting = 1 }, /databasePoolWaitingMax/],
  ['pool waiters', (input) => { input.logs[0].jsonPayload.databasePoolWaitersMax = 5 }, /transient database pool pressure/],
  ['pool wait time', (input) => { input.logs[0].jsonPayload.databasePoolWaitMsMax = 51 }, /transient database pool pressure/],
  ['C27 controls', (input) => input.logs.filter((entry) => entry.jsonPayload.role === 'cell')
    .forEach((entry) => { entry.jsonPayload.controls = 0 }), /did not reach C27/],
  ['C27 splices', (input) => input.logs.filter((entry) => entry.jsonPayload.role === 'cell')
    .forEach((entry) => { entry.jsonPayload.splices = 0 }), /did not reach C27/],
  ['Cloud SQL headroom', (input) => { input.cloudSql = cloudSql(320, canaryEnd) }, /below 320/]
]) {
  test(`rejects C27 evidence with ${label}`, () => {
    const input = canaryInput()
    mutation(input)
    assert.throws(() => buildC27CanaryEvidence(input), message)
  })
}

test('rejects C27 evidence from a different selector generation', () => {
  const evidence = buildC27CanaryEvidence(canaryInput())
  assert.throws(() => verifyRolloutEvidence(
    evidence, workflowRun(evidence),
    verifyExpected('production-c27-canary', { selectorGeneration: 10 })
  ), /selector generation/)
})
