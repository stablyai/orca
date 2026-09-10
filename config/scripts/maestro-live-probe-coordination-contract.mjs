import {
  DEFAULT_MAX_CAPSULE_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  PROBE_SCHEMA_VERSION,
  ProbeContractError,
  assertAbsolutePath,
  getRepositoryTarget,
  isRecord,
  normalizeRepositoryTarget,
  requireInteger,
  requireRecord,
  requireString
} from './maestro-live-probe-process.mjs'

export function resolveLaunchProfile({ provider, model, effort, permission_mode }) {
  requireString(provider, 'provider')
  if (!['codex', 'claude'].includes(provider)) {
    throw new ProbeContractError('unsupported_provider', `Unsupported provider ${provider}`)
  }
  const permission = provider === 'codex' ? 'yolo' : 'dangerously-skip-permissions'
  if (provider === 'claude' && permission_mode === 'auto') {
    throw new ProbeContractError(
      'profile_drift',
      'Claude auto is not an unattended permission mode'
    )
  }
  return {
    provider,
    model: requireString(model, 'model'),
    effort: requireString(effort, 'effort'),
    permission_mode: permission,
    permission_argument: provider === 'codex' ? '--yolo' : '--dangerously-skip-permissions'
  }
}

export function assertLaunchProfile(expected, observed) {
  const expectedProfile = requireRecord(expected, 'Expected launch profile is required')
  const observedProfile = requireRecord(observed, 'Observed launch profile is required')
  const fields = ['provider', 'model', 'effort', 'permission_mode', 'permission_argument']
  if (fields.some((field) => expectedProfile[field] !== observedProfile[field])) {
    throw new ProbeContractError(
      'launch_profile_drift',
      'Observed launch profile does not match the routed profile',
      { expected: expectedProfile, observed: observedProfile }
    )
  }
  return observedProfile
}

export function createProbeProgressTimeline() {
  return [
    {
      state: 'active',
      percentage: 34,
      execution_mode: 'parallel',
      reduction_reason: null,
      findings: [],
      activity_sequence: 1
    },
    {
      state: 'blocked',
      percentage: 58,
      execution_mode: 'parallel',
      reduction_reason: 'blocking finding requires coordinator decision',
      findings: [{ id: 'finding-blocking-01', classification: 'blocking', status: 'open' }],
      activity_sequence: 2
    },
    {
      state: 'partial',
      percentage: 86,
      execution_mode: 'single_writer',
      reduction_reason: 'reduced after blocking packet settled',
      findings: [{ id: 'finding-carry-01', classification: 'carry_forward', status: 'accepted' }],
      activity_sequence: 3
    }
  ]
}

export function validateProgressTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length < 3) {
    throw new ProbeContractError(
      'invalid_progress',
      'Progress timeline must contain active, blocked, and partial states'
    )
  }
  const requiredStates = ['active', 'blocked', 'partial']
  for (const [index, expectedState] of requiredStates.entries()) {
    const snapshot = requireRecord(timeline[index], `Progress snapshot ${index} is invalid`)
    if (snapshot.state !== expectedState) {
      throw new ProbeContractError('invalid_progress', `Progress state ${expectedState} is missing`)
    }
    if (
      !Number.isInteger(snapshot.percentage) ||
      snapshot.percentage < 0 ||
      snapshot.percentage >= 100
    ) {
      throw new ProbeContractError(
        'invalid_progress',
        `${expectedState} must remain below 100 percent`
      )
    }
    if (!Array.isArray(snapshot.findings)) {
      throw new ProbeContractError('invalid_progress', `${expectedState} findings must be an array`)
    }
  }
  for (const snapshot of timeline) {
    const hasFindings = snapshot.findings.length > 0
    const restrictedState = ['blocked', 'partial', 'cleanup'].includes(snapshot.state)
    if (snapshot.state === 'complete' && (hasFindings || snapshot.cleanup === true)) {
      throw new ProbeContractError(
        'invalid_progress',
        'Complete progress is not valid while findings or cleanup remain'
      )
    }
    if (restrictedState && snapshot.percentage >= 100) {
      throw new ProbeContractError(
        'invalid_progress',
        `${snapshot.state} progress must remain below 100 percent`
      )
    }
  }
  const blocked = timeline.find((snapshot) => snapshot.state === 'blocked')
  const partial = timeline.find((snapshot) => snapshot.state === 'partial')
  if (!blocked.findings.some((finding) => finding.classification === 'blocking')) {
    throw new ProbeContractError('invalid_progress', 'Blocked progress requires a blocking finding')
  }
  if (!partial.findings.some((finding) => finding.classification === 'carry_forward')) {
    throw new ProbeContractError(
      'invalid_progress',
      'Partial progress requires a carry-forward finding'
    )
  }
  return timeline
}

export function reduceExecutionPackets(packets, mode) {
  if (!Array.isArray(packets) || packets.length === 0) {
    throw new ProbeContractError('invalid_reduction', 'At least one execution packet is required')
  }
  if (!['single_writer', 'parallel'].includes(mode)) {
    throw new ProbeContractError('invalid_reduction', `Unsupported execution mode ${mode}`)
  }
  const normalized = packets.map((packet) =>
    requireRecord(packet, 'Execution packet must be an object')
  )
  const pendingTaskIds = normalized
    .filter((packet) => packet.status === 'pending')
    .map((packet) => packet.task_id)
  const acceptedReceiptIds = normalized
    .filter((packet) => packet.receipt?.status === 'accepted')
    .map((packet) => packet.receipt.id)
  if (mode === 'parallel') {
    if (normalized.some((packet) => packet.independence !== 'independent')) {
      throw new ProbeContractError(
        'invalid_reduction',
        'Parallel expansion requires independent packets'
      )
    }
    if (normalized.some((packet) => !packet.evidence_ref)) {
      throw new ProbeContractError(
        'invalid_reduction',
        'Parallel expansion requires evidence-backed packets'
      )
    }
  }
  return {
    execution_mode: mode,
    pending_task_ids: pendingTaskIds,
    accepted_receipt_ids: acceptedReceiptIds,
    assigned_packet_ids: mode === 'single_writer' ? normalized.map((packet) => packet.id) : [],
    preserved_pending_tasks: pendingTaskIds.length,
    preserved_accepted_receipts: acceptedReceiptIds.length
  }
}

export function validateReductionReceipt(packets, mode, receipt, field) {
  const expected = requireRecord(receipt, `${field} is required`)
  const actual = reduceExecutionPackets(packets, mode)
  for (const key of [
    'execution_mode',
    'pending_task_ids',
    'accepted_receipt_ids',
    'assigned_packet_ids',
    'preserved_pending_tasks',
    'preserved_accepted_receipts'
  ]) {
    const matches = Array.isArray(actual[key])
      ? Array.isArray(expected[key]) &&
        actual[key].length === expected[key].length &&
        actual[key].every((value, index) => value === expected[key][index])
      : actual[key] === expected[key]
    if (!matches) {
      throw new ProbeContractError(
        'invalid_reduction',
        `${field} does not match the packet reduction result`
      )
    }
  }
  return actual
}

export function validateCoordinationTelemetry(telemetry) {
  const value = requireRecord(telemetry, 'Coordination telemetry is required')
  for (const field of [
    'wall_time_ms',
    'dispatches',
    'operational_terminal_failures',
    'technical_attempts'
  ]) {
    requireInteger(value[field], `coordination.${field}`)
  }
  if ('token_usage' in value && value.token_usage !== null && !isRecord(value.token_usage)) {
    throw new ProbeContractError(
      'invalid_telemetry',
      'token_usage must be omitted, null, or an object'
    )
  }
  if ('cache_usage' in value && value.cache_usage !== null && !isRecord(value.cache_usage)) {
    throw new ProbeContractError(
      'invalid_telemetry',
      'cache_usage must be omitted, null, or an object'
    )
  }
  return value
}

export function normalizeCoordinationTelemetry(telemetry) {
  if (telemetry === undefined || telemetry === null) {
    return null
  }
  return validateCoordinationTelemetry(telemetry)
}

export function validateDetailReference(reference, workspaceKey) {
  const value = requireRecord(reference, 'Detail reference is required')
  if (!['task', 'attempt', 'finding', 'cleanup'].includes(value.kind)) {
    throw new ProbeContractError('invalid_detail_reference', 'Unsupported detail reference kind')
  }
  if (
    value.workspace_key !== workspaceKey ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    throw new ProbeContractError(
      'invalid_detail_reference',
      'Detail reference is outside the pinned workspace'
    )
  }
  return { kind: value.kind, id: value.id, workspace_key: value.workspace_key }
}

export function validateSerialTaskReuse(tasks) {
  if (!Array.isArray(tasks) || tasks.length !== 3) {
    throw new ProbeContractError(
      'invalid_serial_reuse',
      'Exactly three serial task capsules are required'
    )
  }
  const terminalHandles = new Set(tasks.map((task) => task.terminal_handle))
  const capsuleDigests = new Set(tasks.map((task) => task.capsule_digest))
  const taskIds = new Set(tasks.map((task) => task.task_id))
  if (terminalHandles.size !== 1 || capsuleDigests.size !== 3 || taskIds.size !== 3) {
    throw new ProbeContractError(
      'invalid_serial_reuse',
      'Serial tasks must reuse one terminal with distinct capsules'
    )
  }
  if (tasks.some((task) => task.delivery_status === 'failed')) {
    throw new ProbeContractError(
      'capsule_delivery_failed',
      'Capsule delivery failed before the serial task could settle'
    )
  }
  if (tasks.some((task) => task.delivery_status !== 'acknowledged')) {
    throw new ProbeContractError(
      'invalid_serial_reuse',
      'Every serial capsule needs acknowledged delivery'
    )
  }
  return {
    terminal_handle: tasks[0].terminal_handle,
    task_ids: [...taskIds],
    capsule_count: tasks.length
  }
}

export function validateCoordinatorTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new ProbeContractError('invalid_coordinator_timeline', 'Coordinator timeline is required')
  }
  const handoffPhases = [
    'reserved',
    'spawned',
    'capsule_delivery_acknowledged',
    'coordinator_claimed',
    'authority_committed'
  ]
  const names = events.map((event) => event.phase)
  const crashIndex = names.indexOf('crashed')
  const restartIndex = names.indexOf('restarted')
  const predecessorReconcileIndex = names.indexOf('predecessor_reconciled')
  if (crashIndex === -1 || restartIndex === -1 || predecessorReconcileIndex === -1) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Coordinator crash, restart, and predecessor reconciliation are required'
    )
  }
  if (restartIndex !== crashIndex + 1 || predecessorReconcileIndex <= restartIndex) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Coordinator crash/restart/reconcile ordering is invalid'
    )
  }
  const successorAuthorityIndex = events.findIndex(
    (event, index) => index > restartIndex && event.phase === 'authority_committed'
  )
  if (successorAuthorityIndex === -1 || predecessorReconcileIndex < successorAuthorityIndex) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Predecessor reconciled before successor authority'
    )
  }
  const initialHandoff = events.slice(0, crashIndex)
  const successorHandoff = events.slice(restartIndex + 1, predecessorReconcileIndex)
  if (
    initialHandoff.length !== handoffPhases.length ||
    successorHandoff.length !== handoffPhases.length ||
    initialHandoff.map((event) => event.phase).join(',') !== handoffPhases.join(',') ||
    successorHandoff.map((event) => event.phase).join(',') !== handoffPhases.join(',')
  ) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Coordinator handoff ordering is incomplete or mixed across generations'
    )
  }
  const crashed = events[crashIndex]
  const restarted = events[restartIndex]
  if (
    !Number.isInteger(crashed.generation) ||
    !Number.isInteger(restarted.generation) ||
    restarted.generation <= crashed.generation
  ) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Coordinator restart must advance the generation'
    )
  }
  const initialGeneration = initialHandoff[0].generation
  const successorGeneration = successorHandoff[0].generation
  const sameGeneration = (handoff) =>
    handoff.every(
      (event) => Number.isInteger(event.generation) && event.generation === handoff[0].generation
    )
  if (
    !sameGeneration(initialHandoff) ||
    !sameGeneration(successorHandoff) ||
    crashed.generation !== initialGeneration ||
    restarted.generation !== successorGeneration ||
    successorGeneration <= initialGeneration ||
    events[predecessorReconcileIndex].generation !== initialGeneration
  ) {
    throw new ProbeContractError(
      'invalid_coordinator_timeline',
      'Coordinator generations are mixed or predecessor reconciliation is not identity-bound'
    )
  }
  return events
}

export function createContextRollover({ oldSession, freshSession, capsule, resume: _resume }) {
  requireRecord(oldSession, 'Old provider session is required')
  requireRecord(freshSession, 'Fresh provider session is required')
  requireString(oldSession.session_id, 'old_session.session_id')
  requireString(freshSession.session_id, 'fresh_session.session_id')
  if (oldSession.observation !== 'context_exhausted') {
    throw new ProbeContractError(
      'invalid_rollover',
      'Context rollover requires an exhausted provider session'
    )
  }
  if (oldSession.session_id === freshSession.session_id || freshSession.resumed !== false) {
    throw new ProbeContractError(
      'resume_forbidden',
      'Context exhaustion must use a fresh provider session'
    )
  }
  if (freshSession.resume_attempted === true) {
    throw new ProbeContractError('resume_forbidden', 'Provider resume was attempted')
  }
  if (!isRecord(capsule) || capsule.byte_count > DEFAULT_MAX_CAPSULE_BYTES) {
    throw new ProbeContractError('capsule_too_large', 'Fresh session capsule is not bounded')
  }
  if (oldSession.lifecycle !== 'settled' && oldSession.lifecycle !== 'released') {
    throw new ProbeContractError(
      'invalid_rollover',
      'Old provider session was not settled before rollover'
    )
  }
  return {
    observation: 'context_rollover',
    old_session_id: oldSession.session_id,
    fresh_session_id: freshSession.session_id,
    resumed: false,
    capsule_digest: capsule.digest
  }
}

export function validateAttemptDecisionGate(attempts, decision = null) {
  if (!Array.isArray(attempts) || attempts.length < 2) {
    throw new ProbeContractError(
      'invalid_attempt_gate',
      'An implementation and repair attempt are required before the decision gate'
    )
  }
  if (attempts[0]?.kind !== 'implementation' || attempts[1]?.kind !== 'repair') {
    throw new ProbeContractError(
      'invalid_attempt_gate',
      'Technical attempts must begin with one implementation and one repair'
    )
  }
  if (attempts.length === 2) {
    return { allowed: true, decision_id: null }
  }
  if (
    !isRecord(decision) ||
    typeof decision.id !== 'string' ||
    decision.id.length === 0 ||
    decision.authorize_third_attempt !== true ||
    decision.attempt_id !== attempts[2]?.attempt_id
  ) {
    throw new ProbeContractError(
      'attempt_decision_required',
      'A third technical attempt requires an explicit matching decision id'
    )
  }
  return { allowed: true, decision_id: decision.id }
}
export function validateRetainedWorkerRelease(receipt) {
  const value = requireRecord(receipt, 'Retained worker release receipt is required')
  requireString(value.terminal_handle, 'worker.terminal_handle')
  if (value.retained !== true || value.released !== true || value.process_tree_verified !== true) {
    throw new ProbeContractError(
      'cleanup_unverified',
      'Retained worker release lacks retention and verified process cleanup'
    )
  }
  return value
}

export function assertProfileDriftBlocksResult(expected, observed, freshLaunchReceipt = null) {
  let observedMatches = true
  try {
    assertLaunchProfile(expected, observed)
  } catch (error) {
    if (error instanceof ProbeContractError && error.code === 'launch_profile_drift') {
      observedMatches = false
    } else {
      throw error
    }
  }
  if (!isRecord(freshLaunchReceipt)) {
    return {
      accepted: false,
      reason: observedMatches ? 'fresh_matching_launch_required' : 'launch_profile_drift'
    }
  }
  if (
    freshLaunchReceipt.fresh !== true ||
    freshLaunchReceipt.phase !== 'fresh_launch' ||
    typeof freshLaunchReceipt.session_id !== 'string' ||
    typeof freshLaunchReceipt.prior_session_id !== 'string' ||
    freshLaunchReceipt.session_id === freshLaunchReceipt.prior_session_id
  ) {
    return { accepted: false, reason: 'fresh_matching_launch_required' }
  }
  try {
    assertLaunchProfile(expected, freshLaunchReceipt.profile)
  } catch (error) {
    if (error instanceof ProbeContractError && error.code === 'launch_profile_drift') {
      return { accepted: false, reason: 'fresh_matching_launch_required' }
    }
    throw error
  }
  return {
    accepted: true,
    reason: null,
    fresh_session_id: freshLaunchReceipt.session_id
  }
}
const REPOSITORY_TARGETS = [
  { key: 'orca', aliases: ['orca'] },
  { key: 'my-llm-kit', aliases: ['my-llm-kit', 'my_llm_kit'] }
]
export const BROWSER_STATES = new Set([
  'reserved',
  'creating',
  'active',
  'retained',
  'release_pending',
  'released',
  'outcome_unknown',
  'unavailable'
])

export function validateTargetsManifest(value) {
  const targets = requireRecord(value, 'Targets manifest must be an object')
  if (targets.schema_version !== PROBE_SCHEMA_VERSION) {
    throw new ProbeContractError(
      'invalid_targets_manifest',
      `Targets manifest schema_version must be ${PROBE_SCHEMA_VERSION}`
    )
  }

  const repositories = REPOSITORY_TARGETS.map(({ key, aliases }) =>
    normalizeRepositoryTarget(key, getRepositoryTarget(targets, key, aliases))
  )
  if (repositories[0].root === repositories[1].root) {
    throw new ProbeContractError('ambiguous_targets', 'Orca and my-llm-kit roots must be distinct')
  }

  const workspace = requireRecord(targets.execution_workspace, 'execution_workspace is required')
  const workspaceKey = requireString(workspace.workspace_key, 'execution_workspace.workspace_key')
  const browserProfileId = requireString(
    workspace.browser_profile_id,
    'execution_workspace.browser_profile_id'
  )
  const executionHostId = requireString(
    workspace.execution_host_id ?? workspace.host_id,
    'execution_workspace.execution_host_id'
  )
  const workspaceKind = requireString(workspace.kind, 'execution_workspace.kind')
  if (!['folder', 'worktree'].includes(workspaceKind)) {
    throw new ProbeContractError(
      'invalid_workspace',
      'execution workspace kind must be folder or worktree'
    )
  }
  const runtimeProbe = requireRecord(targets.runtime_probe, 'runtime_probe is required')
  const command = requireString(runtimeProbe.command, 'runtime_probe.command')
  const args = runtimeProbe.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new ProbeContractError(
      'invalid_runtime_probe',
      'runtime_probe.args must be string arguments'
    )
  }
  const cwd = assertAbsolutePath(runtimeProbe.cwd ?? repositories[0].root, 'runtime_probe.cwd')
  const timeoutMs = requireInteger(
    runtimeProbe.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    'runtime_probe.timeout_ms',
    { min: 1 }
  )
  const maxOutputBytes = requireInteger(
    runtimeProbe.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'runtime_probe.max_output_bytes',
    { min: 1 }
  )
  const expectedLaunchProfile = resolveLaunchProfile(
    requireRecord(targets.expected_launch_profile, 'expected_launch_profile is required')
  )

  return {
    schema_version: PROBE_SCHEMA_VERSION,
    repositories,
    execution_workspace: {
      workspace_key: workspaceKey,
      execution_host_id: executionHostId,
      kind: workspaceKind,
      browser_profile_id: browserProfileId
    },
    runtime_probe: { command, args, cwd, timeout_ms: timeoutMs, max_output_bytes: maxOutputBytes },
    expected_launch_profile: expectedLaunchProfile
  }
}
