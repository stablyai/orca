const EXPECTED_KEYS = {
  report: ['schemaVersion', 'environment', 'load', 'outcomes'],
  environment: [
    'projectId',
    'directorOrigin',
    'databaseVcpu',
    'databasePoolMax',
    'publicConcurrentMax',
    'resolvePrioritySlots',
    'directorMinInstances',
    'directorMaxInstances',
    'cloudRunConcurrency',
    'rolloutOldPublicConcurrentMax',
    'rolloutOldResolvePrioritySlots',
    'rolloutNewPublicConcurrentMax',
    'rolloutNewResolvePrioritySlots'
  ],
  load: [
    'drainingDesktops',
    'backgroundRequestsPerMinute',
    'backgroundAssignmentRequestsPerMinute',
    'backgroundAssignment503PerMinute',
    'targetConnectionCap',
    'targetCells'
  ],
  targetCell: ['cellId', 'peakConnections', 'recoveredControls'],
  outcomes: [
    'migrationExpirations',
    'migrationAborts',
    'transactionRetryExhaustions',
    'keyProvenTargetRegistrations',
    'oldestMigrationLeaseRemainingAtDrainMs',
    'targetRegistrationDurationMs',
    'assignmentSuccessesPerMinuteBaseline',
    'assignmentSuccessesPerMinuteMinimum',
    'eligibleResolveRequests',
    'resolve2xx',
    'resolveOverload',
    'readinessChecks',
    'readinessFailures',
    'maintenanceOperations',
    'maintenanceFailures',
    'directorPeakInstances',
    'rolloutOverlapPeakInstances',
    'rolloutOverlapPeakPublicOperations',
    'rolloutOverlapEligibleResolveRequests',
    'rolloutOverlapResolve2xx',
    'rolloutOverlapResolveOverload',
    'rolloutOverlapReadinessFailures',
    'rolloutOverlapPoolWaitP95Ms',
    'rolloutOverlapDatabaseCpuPercentMax',
    'poolWaitP95Ms',
    'poolWaitMaxMs',
    'databaseCpuPercentP95',
    'databaseCpuPercentMax',
    'recoveryDurationMs'
  ]
}

const LIMITS = {
  drainingDesktopsMin: 760,
  drainingDesktopsMax: 840,
  backgroundRequestsPerMinuteMin: 10_450,
  backgroundRequestsPerMinuteMax: 11_550,
  backgroundAssignment503PerMinuteMin: 8_500,
  backgroundAssignment503PerMinuteMax: 10_500,
  targetCellCount: 2,
  targetConnectionCap: 600,
  databaseVcpu: 2,
  databasePoolMax: 3,
  publicConcurrentMax: 2,
  resolvePrioritySlots: 1,
  directorMinInstances: 1,
  directorMaxInstances: 2,
  directorPeakInstances: 2,
  rolloutOverlapPeakInstances: 4,
  rolloutOverlapPeakPublicOperations: 8,
  cloudRunConcurrency: 80,
  rolloutOldPublicConcurrentMax: 2,
  rolloutOldResolvePrioritySlots: 0,
  rolloutNewPublicConcurrentMax: 2,
  rolloutNewResolvePrioritySlots: 1,
  assignmentThroughputRetentionMin: 0.9,
  resolveSuccessRateMin: 0.95,
  resolveOverloadRateMaxExclusive: 0.01,
  poolWaitP95MsMaxExclusive: 500,
  poolWaitMaxMsMaxExclusive: 5_000,
  databaseCpuPercentP95MaxExclusive: 70,
  databaseCpuPercentMaxMaxExclusive: 85,
  oldestMigrationLeaseRemainingAtDrainMsMin: 10 * 60_000,
  targetRegistrationDurationMsMax: 5 * 60_000,
  recoveryDurationMsMax: 14 * 60_000
}

export function evaluateRecoveryWaveReport(input) {
  const report = parseReport(input)
  const recoveredControls = report.load.targetCells.reduce(
    (total, cell) => total + cell.recoveredControls,
    0
  )
  const peakTargetConnections = Math.max(
    ...report.load.targetCells.map((cell) => cell.peakConnections)
  )
  const assignmentThroughputRetention = ratio(
    report.outcomes.assignmentSuccessesPerMinuteMinimum,
    report.outcomes.assignmentSuccessesPerMinuteBaseline
  )
  const resolveSuccessRate = ratio(
    report.outcomes.resolve2xx,
    report.outcomes.eligibleResolveRequests
  )
  const resolveOverloadRate = ratio(
    report.outcomes.resolveOverload,
    report.outcomes.eligibleResolveRequests
  )
  const rolloutOverlapResolveSuccessRate = ratio(
    report.outcomes.rolloutOverlapResolve2xx,
    report.outcomes.rolloutOverlapEligibleResolveRequests
  )
  const rolloutOverlapResolveOverloadRate = ratio(
    report.outcomes.rolloutOverlapResolveOverload,
    report.outcomes.rolloutOverlapEligibleResolveRequests
  )
  const thresholds = [
    equal('database_vcpu', report.environment.databaseVcpu, LIMITS.databaseVcpu),
    equal('database_pool_max', report.environment.databasePoolMax, LIMITS.databasePoolMax),
    equal(
      'public_concurrent_max',
      report.environment.publicConcurrentMax,
      LIMITS.publicConcurrentMax
    ),
    equal(
      'resolve_priority_slots',
      report.environment.resolvePrioritySlots,
      LIMITS.resolvePrioritySlots
    ),
    equal(
      'director_min_instances',
      report.environment.directorMinInstances,
      LIMITS.directorMinInstances
    ),
    equal(
      'director_max_instances',
      report.environment.directorMaxInstances,
      LIMITS.directorMaxInstances
    ),
    equal(
      'cloud_run_concurrency',
      report.environment.cloudRunConcurrency,
      LIMITS.cloudRunConcurrency
    ),
    equal(
      'rollout_old_public_concurrent_max',
      report.environment.rolloutOldPublicConcurrentMax,
      LIMITS.rolloutOldPublicConcurrentMax
    ),
    equal(
      'rollout_old_resolve_priority_slots',
      report.environment.rolloutOldResolvePrioritySlots,
      LIMITS.rolloutOldResolvePrioritySlots
    ),
    equal(
      'rollout_new_public_concurrent_max',
      report.environment.rolloutNewPublicConcurrentMax,
      LIMITS.rolloutNewPublicConcurrentMax
    ),
    equal(
      'rollout_new_resolve_priority_slots',
      report.environment.rolloutNewResolvePrioritySlots,
      LIMITS.rolloutNewResolvePrioritySlots
    ),
    between(
      'draining_desktops',
      report.load.drainingDesktops,
      LIMITS.drainingDesktopsMin,
      LIMITS.drainingDesktopsMax
    ),
    between(
      'background_requests_per_minute',
      report.load.backgroundRequestsPerMinute,
      LIMITS.backgroundRequestsPerMinuteMin,
      LIMITS.backgroundRequestsPerMinuteMax
    ),
    between(
      'background_assignment_requests_per_minute',
      report.load.backgroundAssignmentRequestsPerMinute,
      LIMITS.backgroundRequestsPerMinuteMin,
      LIMITS.backgroundRequestsPerMinuteMax
    ),
    between(
      'background_assignment_503_per_minute',
      report.load.backgroundAssignment503PerMinute,
      LIMITS.backgroundAssignment503PerMinuteMin,
      LIMITS.backgroundAssignment503PerMinuteMax
    ),
    atMost(
      'background_assignment_requests_within_total',
      report.load.backgroundAssignmentRequestsPerMinute,
      report.load.backgroundRequestsPerMinute
    ),
    atMost(
      'background_assignment_503_within_assignments',
      report.load.backgroundAssignment503PerMinute,
      report.load.backgroundAssignmentRequestsPerMinute
    ),
    equal('target_cell_count', report.load.targetCells.length, LIMITS.targetCellCount),
    equal(
      'target_connection_cap',
      report.load.targetConnectionCap,
      LIMITS.targetConnectionCap
    ),
    atMost(
      'peak_target_connections',
      peakTargetConnections,
      report.load.targetConnectionCap
    ),
    equal('recovered_controls', recoveredControls, report.load.drainingDesktops),
    equal('migration_expirations', report.outcomes.migrationExpirations, 0),
    equal('migration_aborts', report.outcomes.migrationAborts, 0),
    equal('transaction_retry_exhaustions', report.outcomes.transactionRetryExhaustions, 0),
    equal(
      'key_proven_target_registrations',
      report.outcomes.keyProvenTargetRegistrations,
      report.load.drainingDesktops
    ),
    atLeast(
      'oldest_migration_lease_remaining_at_drain_ms',
      report.outcomes.oldestMigrationLeaseRemainingAtDrainMs,
      LIMITS.oldestMigrationLeaseRemainingAtDrainMsMin
    ),
    atMost(
      'target_registration_duration_ms',
      report.outcomes.targetRegistrationDurationMs,
      LIMITS.targetRegistrationDurationMsMax
    ),
    atLeast(
      'assignment_throughput_retention',
      assignmentThroughputRetention,
      LIMITS.assignmentThroughputRetentionMin
    ),
    atLeast('resolve_success_rate', resolveSuccessRate, LIMITS.resolveSuccessRateMin),
    lessThan(
      'resolve_overload_rate',
      resolveOverloadRate,
      LIMITS.resolveOverloadRateMaxExclusive
    ),
    atLeast('eligible_resolve_requests', report.outcomes.eligibleResolveRequests, 100),
    equal('readiness_failures', report.outcomes.readinessFailures, 0),
    atLeast('readiness_checks', report.outcomes.readinessChecks, 1),
    equal('maintenance_failures', report.outcomes.maintenanceFailures, 0),
    atLeast('maintenance_operations', report.outcomes.maintenanceOperations, 1),
    equal(
      'director_peak_instances',
      report.outcomes.directorPeakInstances,
      LIMITS.directorPeakInstances
    ),
    equal(
      'rollout_overlap_peak_instances',
      report.outcomes.rolloutOverlapPeakInstances,
      LIMITS.rolloutOverlapPeakInstances
    ),
    equal(
      'rollout_overlap_peak_public_operations',
      report.outcomes.rolloutOverlapPeakPublicOperations,
      LIMITS.rolloutOverlapPeakPublicOperations
    ),
    atLeast(
      'rollout_overlap_eligible_resolve_requests',
      report.outcomes.rolloutOverlapEligibleResolveRequests,
      100
    ),
    atLeast(
      'rollout_overlap_resolve_success_rate',
      rolloutOverlapResolveSuccessRate,
      LIMITS.resolveSuccessRateMin
    ),
    lessThan(
      'rollout_overlap_resolve_overload_rate',
      rolloutOverlapResolveOverloadRate,
      LIMITS.resolveOverloadRateMaxExclusive
    ),
    equal(
      'rollout_overlap_readiness_failures',
      report.outcomes.rolloutOverlapReadinessFailures,
      0
    ),
    lessThan(
      'rollout_overlap_pool_wait_p95_ms',
      report.outcomes.rolloutOverlapPoolWaitP95Ms,
      LIMITS.poolWaitP95MsMaxExclusive
    ),
    lessThan(
      'rollout_overlap_database_cpu_percent_max',
      report.outcomes.rolloutOverlapDatabaseCpuPercentMax,
      LIMITS.databaseCpuPercentMaxMaxExclusive
    ),
    lessThan(
      'pool_wait_p95_ms',
      report.outcomes.poolWaitP95Ms,
      LIMITS.poolWaitP95MsMaxExclusive
    ),
    lessThan(
      'pool_wait_max_ms',
      report.outcomes.poolWaitMaxMs,
      LIMITS.poolWaitMaxMsMaxExclusive
    ),
    lessThan(
      'database_cpu_percent_p95',
      report.outcomes.databaseCpuPercentP95,
      LIMITS.databaseCpuPercentP95MaxExclusive
    ),
    lessThan(
      'database_cpu_percent_max',
      report.outcomes.databaseCpuPercentMax,
      LIMITS.databaseCpuPercentMaxMaxExclusive
    ),
    atMost(
      'recovery_duration_ms',
      report.outcomes.recoveryDurationMs,
      LIMITS.recoveryDurationMsMax
    )
  ]
  return {
    schemaVersion: 1,
    status: thresholds.every(({ pass }) => pass) ? 'PASS' : 'FAIL',
    environment: {
      projectId: report.environment.projectId,
      directorOrigin: report.environment.directorOrigin
    },
    metrics: {
      recoveredControls,
      peakTargetConnections,
      assignmentThroughputRetention,
      resolveSuccessRate,
      resolveOverloadRate,
      rolloutOverlapResolveSuccessRate,
      rolloutOverlapResolveOverloadRate
    },
    thresholds
  }
}

function parseReport(input) {
  const report = strictObject(input, EXPECTED_KEYS.report, 'report')
  if (report.schemaVersion !== 1) throw new Error('unsupported report schemaVersion')
  const environment = strictObject(
    report.environment,
    EXPECTED_KEYS.environment,
    'environment'
  )
  assertSafeEnvironment(environment)
  const load = strictObject(report.load, EXPECTED_KEYS.load, 'load')
  if (!Array.isArray(load.targetCells)) throw new Error('load.targetCells must be an array')
  const targetCells = load.targetCells.map((value, index) => {
    const cell = strictObject(value, EXPECTED_KEYS.targetCell, `load.targetCells[${index}]`)
    if (!/^[a-z0-9-]{1,128}$/.test(cell.cellId)) throw new Error('target cellId is invalid')
    return {
      cellId: cell.cellId,
      peakConnections: nonnegativeNumber(cell.peakConnections, 'peakConnections'),
      recoveredControls: nonnegativeNumber(cell.recoveredControls, 'recoveredControls')
    }
  })
  if (new Set(targetCells.map(({ cellId }) => cellId)).size !== targetCells.length) {
    throw new Error('target cell IDs must be unique')
  }
  const outcomes = strictObject(report.outcomes, EXPECTED_KEYS.outcomes, 'outcomes')
  return {
    schemaVersion: 1,
    environment: {
      projectId: environment.projectId,
      directorOrigin: environment.directorOrigin,
      databaseVcpu: positiveNumber(environment.databaseVcpu, 'databaseVcpu'),
      databasePoolMax: positiveNumber(environment.databasePoolMax, 'databasePoolMax'),
      publicConcurrentMax: positiveNumber(
        environment.publicConcurrentMax,
        'publicConcurrentMax'
      ),
      resolvePrioritySlots: positiveNumber(
        environment.resolvePrioritySlots,
        'resolvePrioritySlots'
      ),
      directorMinInstances: positiveNumber(
        environment.directorMinInstances,
        'directorMinInstances'
      ),
      directorMaxInstances: positiveNumber(
        environment.directorMaxInstances,
        'directorMaxInstances'
      ),
      cloudRunConcurrency: positiveNumber(
        environment.cloudRunConcurrency,
        'cloudRunConcurrency'
      ),
      rolloutOldPublicConcurrentMax: positiveNumber(
        environment.rolloutOldPublicConcurrentMax,
        'rolloutOldPublicConcurrentMax'
      ),
      rolloutOldResolvePrioritySlots: nonnegativeNumber(
        environment.rolloutOldResolvePrioritySlots,
        'rolloutOldResolvePrioritySlots'
      ),
      rolloutNewPublicConcurrentMax: positiveNumber(
        environment.rolloutNewPublicConcurrentMax,
        'rolloutNewPublicConcurrentMax'
      ),
      rolloutNewResolvePrioritySlots: positiveNumber(
        environment.rolloutNewResolvePrioritySlots,
        'rolloutNewResolvePrioritySlots'
      )
    },
    load: {
      drainingDesktops: positiveNumber(load.drainingDesktops, 'drainingDesktops'),
      backgroundRequestsPerMinute: positiveNumber(
        load.backgroundRequestsPerMinute,
        'backgroundRequestsPerMinute'
      ),
      backgroundAssignmentRequestsPerMinute: positiveNumber(
        load.backgroundAssignmentRequestsPerMinute,
        'backgroundAssignmentRequestsPerMinute'
      ),
      backgroundAssignment503PerMinute: nonnegativeNumber(
        load.backgroundAssignment503PerMinute,
        'backgroundAssignment503PerMinute'
      ),
      targetConnectionCap: positiveNumber(load.targetConnectionCap, 'targetConnectionCap'),
      targetCells
    },
    outcomes: Object.fromEntries(
      EXPECTED_KEYS.outcomes.map((key) => [key, nonnegativeNumber(outcomes[key], `outcomes.${key}`)])
    )
  }
}

function assertSafeEnvironment(environment) {
  if (typeof environment.projectId !== 'string') throw new Error('projectId must be a string')
  if (
    environment.projectId !== 'local' &&
    !environment.projectId.endsWith('-staging') &&
    !environment.projectId.endsWith('-test')
  ) {
    throw new Error('recovery-wave reports must come from an isolated non-production project')
  }
  if (typeof environment.directorOrigin !== 'string') {
    throw new Error('directorOrigin must be a string')
  }
  const origin = new URL(environment.directorOrigin)
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(origin.hostname)
  const isolatedHost =
    loopback || origin.hostname.endsWith('.test') || origin.hostname.includes('staging')
  if (
    origin.origin !== environment.directorOrigin ||
    origin.pathname !== '/' ||
    (!loopback && origin.protocol !== 'https:') ||
    !isolatedHost
  ) {
    throw new Error('directorOrigin must identify a canonical isolated non-production origin')
  }
}

function strictObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unexpected or missing fields`)
  }
  return value
}

function positiveNumber(value, name) {
  const number = nonnegativeNumber(value, name)
  if (number <= 0) throw new Error(`${name} must be positive`)
  return number
}

function nonnegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite nonnegative number`)
  }
  return value
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator
}

function equal(name, observed, limit) {
  return threshold(name, observed, '==', limit, observed === limit)
}

function atLeast(name, observed, limit) {
  return threshold(name, observed, '>=', limit, observed >= limit)
}

function atMost(name, observed, limit) {
  return threshold(name, observed, '<=', limit, observed <= limit)
}

function lessThan(name, observed, limit) {
  return threshold(name, observed, '<', limit, observed < limit)
}

function between(name, observed, minimum, maximum) {
  return threshold(
    name,
    observed,
    'between_inclusive',
    [minimum, maximum],
    observed >= minimum && observed <= maximum
  )
}

function threshold(name, observed, operator, limit, pass) {
  return { name, observed, operator, limit, pass }
}
