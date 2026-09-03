import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRecoveryWaveReport } from './relay-recovery-wave-gate.mjs'

test('passes a complete isolated production-shaped recovery report', () => {
  const result = evaluateRecoveryWaveReport(passingReport())

  assert.equal(result.status, 'PASS')
  assert.equal(result.metrics.recoveredControls, 800)
  assert.equal(result.metrics.peakTargetConnections, 425)
  assert.equal(result.metrics.resolveSuccessRate, 0.99)
  assert.equal(result.thresholds.every(({ pass }) => pass), true)
  assert.equal(
    result.thresholds.find(({ name }) => name === 'recovery_duration_ms')?.limit,
    840_000
  )
})

for (const [name, mutate, failedThreshold] of [
  [
    'target connection ceiling',
    (report) => {
      report.load.targetCells[0].peakConnections = 601
    },
    'peak_target_connections'
  ],
  [
    'migration expiration',
    (report) => {
      report.outcomes.migrationExpirations = 1
    },
    'migration_expirations'
  ],
  [
    'migration abort',
    (report) => {
      report.outcomes.migrationAborts = 1
    },
    'migration_aborts'
  ],
  [
    'full-wave registration deadline',
    (report) => {
      report.outcomes.targetRegistrationDurationMs = 300_001
    },
    'target_registration_duration_ms'
  ],
  [
    'legacy assignment background shape',
    (report) => {
      report.load.backgroundAssignment503PerMinute = 100
    },
    'background_assignment_503_per_minute'
  ],
  [
    'production director instance topology',
    (report) => {
      report.outcomes.directorPeakInstances = 1
    },
    'director_peak_instances'
  ],
  [
    'old/new rollout overlap topology',
    (report) => {
      report.outcomes.rolloutOverlapPeakInstances = 2
    },
    'rollout_overlap_peak_instances'
  ],
  [
    'old revision shared admission mode',
    (report) => {
      report.environment.rolloutOldResolvePrioritySlots = 1
    },
    'rollout_old_resolve_priority_slots'
  ],
  [
    'old/new rollout overlap resolve availability',
    (report) => {
      report.outcomes.rolloutOverlapResolveOverload = 2
    },
    'rollout_overlap_resolve_overload_rate'
  ],
  [
    'resolve availability',
    (report) => {
      report.outcomes.resolve2xx = 940
      report.outcomes.resolveOverload = 20
    },
    'resolve_success_rate'
  ],
  [
    'pool wait',
    (report) => {
      report.outcomes.poolWaitP95Ms = 500
    },
    'pool_wait_p95_ms'
  ],
  [
    'database CPU',
    (report) => {
      report.outcomes.databaseCpuPercentMax = 85
    },
    'database_cpu_percent_max'
  ],
  [
    'recovery deadline',
    (report) => {
      report.outcomes.recoveryDurationMs = 840_001
    },
    'recovery_duration_ms'
  ],
  [
    'non-public database maintenance',
    (report) => {
      report.outcomes.maintenanceFailures = 1
    },
    'maintenance_failures'
  ]
]) {
  test(`fails closed on ${name}`, () => {
    const report = passingReport()
    mutate(report)
    const result = evaluateRecoveryWaveReport(report)

    assert.equal(result.status, 'FAIL')
    assert.equal(
      result.thresholds.find(({ name: thresholdName }) => thresholdName === failedThreshold)?.pass,
      false
    )
  })
}

test('rejects production provenance and unexpected report fields', () => {
  const productionProject = passingReport()
  productionProject.environment.projectId = 'onorca-cloud'
  assert.throws(
    () => evaluateRecoveryWaveReport(productionProject),
    /isolated non-production project/
  )

  const productionOrigin = passingReport()
  productionOrigin.environment.directorOrigin = 'https://relay.onorca.dev'
  assert.throws(
    () => evaluateRecoveryWaveReport(productionOrigin),
    /isolated non-production origin/
  )

  const extraField = passingReport()
  extraField.environment.accessToken = 'must-not-be-accepted'
  assert.throws(() => evaluateRecoveryWaveReport(extraField), /unexpected or missing fields/)
})

function passingReport() {
  return {
    schemaVersion: 1,
    environment: {
      projectId: 'onorca-cloud-staging',
      directorOrigin: 'https://relay-staging.onorca.dev',
      databaseVcpu: 2,
      databasePoolMax: 3,
      publicConcurrentMax: 2,
      resolvePrioritySlots: 1,
      directorMinInstances: 1,
      directorMaxInstances: 2,
      cloudRunConcurrency: 80,
      rolloutOldPublicConcurrentMax: 2,
      rolloutOldResolvePrioritySlots: 0,
      rolloutNewPublicConcurrentMax: 2,
      rolloutNewResolvePrioritySlots: 1
    },
    load: {
      drainingDesktops: 800,
      backgroundRequestsPerMinute: 11_000,
      backgroundAssignmentRequestsPerMinute: 10_950,
      backgroundAssignment503PerMinute: 9_500,
      targetConnectionCap: 600,
      targetCells: [
        { cellId: 'target-a', peakConnections: 425, recoveredControls: 400 },
        { cellId: 'target-b', peakConnections: 419, recoveredControls: 400 }
      ]
    },
    outcomes: {
      migrationExpirations: 0,
      migrationAborts: 0,
      transactionRetryExhaustions: 0,
      keyProvenTargetRegistrations: 800,
      oldestMigrationLeaseRemainingAtDrainMs: 660_000,
      targetRegistrationDurationMs: 240_000,
      assignmentSuccessesPerMinuteBaseline: 1_400,
      assignmentSuccessesPerMinuteMinimum: 1_330,
      eligibleResolveRequests: 1_000,
      resolve2xx: 990,
      resolveOverload: 5,
      readinessChecks: 180,
      readinessFailures: 0,
      maintenanceOperations: 30,
      maintenanceFailures: 0,
      directorPeakInstances: 2,
      rolloutOverlapPeakInstances: 4,
      rolloutOverlapPeakPublicOperations: 8,
      rolloutOverlapEligibleResolveRequests: 100,
      rolloutOverlapResolve2xx: 99,
      rolloutOverlapResolveOverload: 0,
      rolloutOverlapReadinessFailures: 0,
      rolloutOverlapPoolWaitP95Ms: 180,
      rolloutOverlapDatabaseCpuPercentMax: 78,
      poolWaitP95Ms: 120,
      poolWaitMaxMs: 900,
      databaseCpuPercentP95: 55,
      databaseCpuPercentMax: 72,
      recoveryDurationMs: 360_000
    }
  }
}
