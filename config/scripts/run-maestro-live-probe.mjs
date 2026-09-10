import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_MAX_CAPSULE_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ProbeContractError,
  PROBE_SCHEMA_VERSION,
  assertAbsolutePath,
  containsKey,
  createImmutableCapsule,
  createOwnedResourceScope,
  installProbeSignalHandlers,
  isRecord,
  requireInteger,
  requireRecord,
  requireString,
  runBoundedCommand
} from './maestro-live-probe-process.mjs'
import {
  assertLaunchProfile,
  assertProfileDriftBlocksResult,
  BROWSER_STATES,
  createContextRollover,
  createProbeProgressTimeline,
  normalizeCoordinationTelemetry,
  reduceExecutionPackets,
  resolveLaunchProfile,
  validateAttemptDecisionGate,
  validateCoordinationTelemetry,
  validateCoordinatorTimeline,
  validateDetailReference,
  validateProgressTimeline,
  validateReductionReceipt,
  validateRetainedWorkerRelease,
  validateSerialTaskReuse,
  validateTargetsManifest
} from './maestro-live-probe-coordination-contract.mjs'

function invalidBrowserEvidence(message) {
  throw new ProbeContractError('invalid_browser_receipt', message)
}

function validateBrowserEvidenceReceipt(evidence, viewport) {
  const value = requireRecord(evidence, 'Browser evidence receipt is required')
  if (value.protocol !== 'maestro-browser-evidence/v1') {
    invalidBrowserEvidence('Browser evidence protocol is invalid')
  }
  requireString(value.artifact_ref, 'browser.evidence_receipt.artifact_ref')
  if (!value.artifact_ref.startsWith('file:') || value.artifact_ref.startsWith('file://')) {
    invalidBrowserEvidence('Browser evidence artifact reference is not canonical')
  }
  requireString(value.artifact_hash, 'browser.evidence_receipt.artifact_hash')
  if (!/^sha256:[0-9a-f]{64}$/.test(value.artifact_hash)) {
    invalidBrowserEvidence('Browser evidence artifact hash is invalid')
  }
  if (value.format !== 'png' || value.capture_mode !== 'native-viewport') {
    invalidBrowserEvidence('Browser evidence must be native PNG viewport capture')
  }
  const dimensions = requireRecord(value.dimensions, 'Browser evidence dimensions are required')
  for (const field of ['width', 'height', 'device_scale_factor']) {
    if (
      !Number.isFinite(dimensions[field]) ||
      dimensions[field] <= 0 ||
      dimensions[field] !== viewport[field]
    ) {
      invalidBrowserEvidence('Browser evidence dimensions do not match the viewport')
    }
  }
  requireString(value.source_revision, 'browser.evidence_receipt.source_revision')
  requireString(value.captured_at, 'browser.evidence_receipt.captured_at')
  const visionReview = requireRecord(
    value.vision_review,
    'Browser evidence vision review is required'
  )
  if (visionReview.outcome !== 'pass') {
    invalidBrowserEvidence('Browser evidence vision review must pass')
  }
  requireString(visionReview.observation, 'browser.evidence_receipt.vision_review.observation')
  return value
}

function readGitValue(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function readRepositoryIdentity(root) {
  const canonicalRoot = assertAbsolutePath(
    readGitValue(root, ['rev-parse', '--show-toplevel']),
    'repository.root'
  )
  const revision = readGitValue(canonicalRoot, ['rev-parse', 'HEAD'])
  let repositoryId = canonicalRoot
  try {
    repositoryId =
      readGitValue(canonicalRoot, ['config', '--get', 'remote.origin.url']) || canonicalRoot
  } catch {
    repositoryId = canonicalRoot
  }
  return { root: canonicalRoot, revision, repository_id: repositoryId }
}

export function verifyTargetRepositories(manifest, inspect = readRepositoryIdentity) {
  const targets = validateTargetsManifest(manifest)
  const verified = targets.repositories.map((target) => {
    let actual
    try {
      actual = inspect(target.root, target.key)
    } catch (error) {
      throw new ProbeContractError(
        'repository_probe_failed',
        `Could not inspect ${target.key} repository identity`,
        { target: target.key, cause: String(error) }
      )
    }
    if (!isRecord(actual)) {
      throw new ProbeContractError(
        'repository_identity_mismatch',
        `${target.key} identity is missing`
      )
    }
    const actualRoot = assertAbsolutePath(actual.root, `${target.key}.root`)
    if (actualRoot !== target.root) {
      throw new ProbeContractError(
        'repository_identity_mismatch',
        `${target.key} root identity differs`,
        {
          expected: target.root,
          actual: actualRoot
        }
      )
    }
    if (actual.revision !== target.revision || actual.repository_id !== target.repository_id) {
      throw new ProbeContractError(
        'repository_identity_mismatch',
        `${target.key} revision or repository identity differs`,
        { expected: target, actual }
      )
    }
    return { ...target, verified: true }
  })
  return { ...targets, repositories: verified }
}

export function validateBrowserReceipt(receipt, workspaceKey, expectedProfileId) {
  requireString(expectedProfileId, 'expectedProfileId')
  const value = requireRecord(receipt, 'Browser receipt is required')
  if (value.schema_version !== PROBE_SCHEMA_VERSION) {
    throw new ProbeContractError(
      'invalid_browser_receipt',
      'Browser receipt schema_version must be 1'
    )
  }
  if (value.protocol !== 'maestro-browser-surface/v1') {
    throw new ProbeContractError('invalid_browser_receipt', 'Browser receipt protocol is invalid')
  }
  for (const field of [
    'surface_id',
    'request_id',
    'run_id',
    'task_id',
    'attempt_id',
    'agent_id',
    'owner_principal',
    'browser_page_id',
    'execution_host_id',
    'workspace_key',
    'title',
    'url',
    'origin',
    'created_at',
    'updated_at'
  ]) {
    requireString(value[field], `browser.${field}`)
  }
  if (value.workspace_key !== workspaceKey) {
    throw new ProbeContractError('browser_identity_mismatch', 'Browser receipt workspace differs')
  }
  if (value.ownership !== 'harness') {
    throw new ProbeContractError(
      'browser_ownership_mismatch',
      'Browser receipt is not Harness-owned'
    )
  }
  if (!BROWSER_STATES.has(value.state)) {
    throw new ProbeContractError('invalid_browser_receipt', 'Browser receipt state is invalid')
  }
  if (value.profile_id !== expectedProfileId) {
    throw new ProbeContractError(
      'browser_profile_mismatch',
      'Browser receipt reused an unexpected profile'
    )
  }
  if (!['visible', 'offscreen'].includes(value.requested_visibility)) {
    throw new ProbeContractError('invalid_browser_receipt', 'Browser visibility request is invalid')
  }
  if (
    value.observed_visibility !== value.requested_visibility ||
    !['visible', 'offscreen'].includes(value.observed_visibility)
  ) {
    throw new ProbeContractError(
      'invalid_browser_receipt',
      'Browser visibility was silently downgraded'
    )
  }
  const viewport = requireRecord(value.viewport, 'Browser viewport is required')
  for (const field of ['width', 'height', 'device_scale_factor']) {
    if (!Number.isFinite(viewport[field]) || viewport[field] <= 0) {
      throw new ProbeContractError('invalid_browser_receipt', 'Browser viewport is invalid')
    }
  }
  if (
    value.requested_visibility === 'visible' &&
    (!isRecord(value.focus_receipt) ||
      value.focus_receipt.requested !== true ||
      value.focus_receipt.workspace_activated !== true ||
      value.focus_receipt.exact_page_selected !== true ||
      value.focus_receipt.native_pane_paint !== 'painted')
  ) {
    throw new ProbeContractError(
      'invalid_browser_receipt',
      'Visible Browser receipt lacks focus and paint proof'
    )
  }
  if (value.requested_visibility === 'visible') {
    validateBrowserEvidenceReceipt(value.evidence_receipt, viewport)
  } else if (value.evidence_receipt !== null && value.evidence_receipt !== undefined) {
    validateBrowserEvidenceReceipt(value.evidence_receipt, viewport)
  }
  if (!isRecord(value.release_receipt)) {
    throw new ProbeContractError('invalid_browser_receipt', 'Browser receipt lacks release receipt')
  }
  if (value.release_receipt.profile_affected !== false) {
    throw new ProbeContractError(
      'browser_privacy_violation',
      'Browser release receipt must preserve the profile'
    )
  }
  for (const key of ['screenshot', 'screenshot_bytes', 'html', 'cookies', 'storage']) {
    if (containsKey(value, key)) {
      throw new ProbeContractError('browser_privacy_violation', `Browser receipt contains ${key}`)
    }
  }
  return value
}

export function createBrowserSurfaceRegistry(workspaceKey, expectedProfileId) {
  requireString(expectedProfileId, 'expectedProfileId')
  const surfaces = new Map()
  return {
    open(receipt) {
      const normalized = validateBrowserReceipt(receipt, workspaceKey, expectedProfileId)
      if (surfaces.has(normalized.browser_page_id)) {
        throw new ProbeContractError('duplicate_browser_page', 'Browser page is already owned')
      }
      surfaces.set(normalized.browser_page_id, { ...normalized, lifecycle: 'open' })
      return normalized
    },
    retain(browserPageId) {
      const surface = surfaces.get(browserPageId)
      if (!surface) {
        throw new ProbeContractError('browser_not_found', 'Browser page is not owned')
      }
      surface.lifecycle = 'retained'
      return { browser_page_id: browserPageId, lifecycle: surface.lifecycle }
    },
    release(browserPageId, releaseReceipt) {
      const surface = surfaces.get(browserPageId)
      if (!surface) {
        throw new ProbeContractError('browser_not_found', 'Browser page is not owned')
      }
      if (releaseReceipt.browser_page_id !== browserPageId) {
        throw new ProbeContractError(
          'browser_identity_mismatch',
          'Release targeted a different Browser page'
        )
      }
      if (releaseReceipt.closed !== true) {
        throw new ProbeContractError(
          'cleanup_unverified',
          'Browser release lacks exact close proof'
        )
      }
      surfaces.delete(browserPageId)
      return { browser_page_id: browserPageId, lifecycle: 'released' }
    },
    list() {
      return [...surfaces.values()].map(({ browser_page_id, lifecycle, requested_visibility }) => ({
        browser_page_id,
        lifecycle,
        requested_visibility
      }))
    }
  }
}

export function validateProbeArtifact(artifact, targets) {
  const value = requireRecord(artifact, 'Probe artifact must be an object')
  if (value.schema_version !== PROBE_SCHEMA_VERSION || value.task_id !== 'ORC-11P') {
    throw new ProbeContractError('invalid_artifact', 'Probe artifact identity is invalid')
  }
  if (value.execution_workspace?.workspace_key !== targets.execution_workspace.workspace_key) {
    throw new ProbeContractError('invalid_artifact', 'Probe artifact workspace is not pinned')
  }
  validateProgressTimeline(value.progress)
  if (!isRecord(value.coordination_telemetry)) {
    throw new ProbeContractError(
      'invalid_artifact',
      'Probe artifact coordination telemetry base is required'
    )
  }
  validateCoordinationTelemetry(value.coordination_telemetry)
  if (!Array.isArray(value.attempts) || !('decision' in value)) {
    throw new ProbeContractError(
      'invalid_attempt_gate',
      'Probe artifact attempt decision gate is required'
    )
  }
  try {
    validateAttemptDecisionGate(value.attempts, value.decision ?? null)
  } catch (error) {
    if (error instanceof ProbeContractError) {
      throw new ProbeContractError('invalid_attempt_gate', error.message, { cause: error.code })
    }
    throw error
  }
  const callerLaunchProfile = requireRecord(
    targets.expected_launch_profile,
    'Caller-pinned expected launch profile is required'
  )
  const artifactLaunchProfile = requireRecord(
    value.expected_launch_profile,
    'Probe artifact expected launch profile is required'
  )
  try {
    assertLaunchProfile(callerLaunchProfile, artifactLaunchProfile)
  } catch (error) {
    if (error instanceof ProbeContractError) {
      throw new ProbeContractError(
        'launch_profile_drift',
        'Probe artifact expected launch profile differs from caller-pinned launch profile',
        { cause: error.code }
      )
    }
    throw error
  }
  const observedLaunchProfile = requireRecord(
    value.observed_launch_profile,
    'Probe artifact observed launch profile is required'
  )
  const profileGate = assertProfileDriftBlocksResult(
    callerLaunchProfile,
    observedLaunchProfile,
    value.fresh_launch_receipt ?? null
  )
  if (profileGate.accepted !== true) {
    throw new ProbeContractError(
      'launch_profile_drift',
      `Probe artifact launch profile gate failed: ${profileGate.reason}`
    )
  }
  const rollover = requireRecord(
    value.context_rollover,
    'Probe artifact context rollover is required'
  )
  const oldSession = requireRecord(rollover.old_session, 'Probe artifact old session is required')
  const freshSession = requireRecord(
    rollover.fresh_session,
    'Probe artifact fresh session is required'
  )
  const rolloverCapsule = requireRecord(
    rollover.capsule,
    'Probe artifact rollover capsule is required'
  )
  requireString(rolloverCapsule.digest, 'context_rollover.capsule.digest')
  requireInteger(rolloverCapsule.byte_count, 'context_rollover.capsule.byte_count')
  createContextRollover({
    oldSession,
    freshSession,
    capsule: rolloverCapsule
  })
  const freshLaunchReceipt = requireRecord(
    value.fresh_launch_receipt,
    'Probe artifact fresh launch receipt is required'
  )
  requireString(freshLaunchReceipt.session_id, 'fresh_launch_receipt.session_id')
  requireString(freshLaunchReceipt.prior_session_id, 'fresh_launch_receipt.prior_session_id')
  if (
    freshLaunchReceipt.session_id !== freshSession.session_id ||
    freshLaunchReceipt.prior_session_id !== oldSession.session_id
  ) {
    throw new ProbeContractError(
      'invalid_rollover',
      'Fresh launch receipt session IDs do not match context rollover sessions'
    )
  }
  validateRetainedWorkerRelease(value.retained_worker_release)
  if (!Array.isArray(value.execution_packets) || value.execution_packets.length === 0) {
    throw new ProbeContractError(
      'invalid_reduction',
      'Probe artifact execution packets are required'
    )
  }
  validateReductionReceipt(
    value.execution_packets,
    'single_writer',
    value.reduction_receipt,
    'Probe artifact reduction receipt'
  )
  validateReductionReceipt(
    value.execution_packets,
    'parallel',
    value.expansion_receipt,
    'Probe artifact expansion receipt'
  )
  validateSerialTaskReuse(value.serial_tasks)
  validateCoordinatorTimeline(value.coordinator_timeline)
  if (!Array.isArray(value.detail_references)) {
    throw new ProbeContractError(
      'invalid_artifact',
      'Probe artifact detail references are required'
    )
  }
  value.detail_references.forEach((reference) =>
    validateDetailReference(reference, targets.execution_workspace.workspace_key)
  )
  if (!Array.isArray(value.browser_receipts) || value.browser_receipts.length === 0) {
    throw new ProbeContractError('invalid_artifact', 'Probe artifact Browser receipts are required')
  }
  const expectedProfileId = requireString(value.expected_profile_id, 'artifact.expected_profile_id')
  if (expectedProfileId !== targets.execution_workspace.browser_profile_id) {
    throw new ProbeContractError(
      'browser_profile_mismatch',
      'Probe artifact profile differs from the caller-pinned Browser profile'
    )
  }
  value.browser_receipts.forEach((receipt) =>
    validateBrowserReceipt(receipt, targets.execution_workspace.workspace_key, expectedProfileId)
  )
  for (const receipt of value.browser_receipts) {
    if (
      receipt.ownership !== 'harness' ||
      receipt.state !== 'released' ||
      receipt.release_receipt?.requested !== true ||
      receipt.release_receipt?.outcome !== 'released' ||
      receipt.release_receipt?.exact_page_closed !== true ||
      receipt.release_receipt?.profile_affected !== false
    ) {
      throw new ProbeContractError(
        'cleanup_unverified',
        'Final Browser receipts must prove released Harness-owned pages'
      )
    }
  }
  const cleanup = requireRecord(value.cleanup, 'Probe artifact cleanup is required')
  for (const field of ['live_owned_resources', 'open_browser_pages', 'open_processes']) {
    requireInteger(cleanup[field], `cleanup.${field}`)
    if (cleanup[field] !== 0) {
      throw new ProbeContractError('cleanup_unverified', `cleanup.${field} must be zero`)
    }
  }
  if (
    cleanup.user_owned_resources_touched !== false ||
    cleanup.unrelated_workspaces_touched !== false
  ) {
    throw new ProbeContractError(
      'cleanup_unverified',
      'Probe cleanup touched resources outside its ownership'
    )
  }
  return value
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ProbeContractError('invalid_targets_manifest', `Could not read JSON at ${path}`, {
      cause: String(error)
    })
  }
}

export async function runMaestroLiveProbe({
  targets,
  artifactPath,
  verifyRepositories = true,
  inspectRepository,
  run = runBoundedCommand,
  signal
}) {
  const normalizedTargets = verifyRepositories
    ? verifyTargetRepositories(targets, inspectRepository)
    : validateTargetsManifest(targets)
  const commandResult = await run({
    command: normalizedTargets.runtime_probe.command,
    args: normalizedTargets.runtime_probe.args,
    cwd: normalizedTargets.runtime_probe.cwd,
    timeoutMs: normalizedTargets.runtime_probe.timeout_ms,
    maxOutputBytes: normalizedTargets.runtime_probe.max_output_bytes,
    signal
  })
  if (commandResult.error_code || commandResult.status !== 0 || commandResult.signal) {
    throw new ProbeContractError(
      'runtime_probe_failed',
      'Runtime probe command did not complete successfully',
      {
        status: commandResult.status,
        signal: commandResult.signal,
        error_code: commandResult.error_code,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr
      }
    )
  }
  let artifact
  try {
    artifact = JSON.parse(commandResult.stdout)
  } catch (error) {
    throw new ProbeContractError('invalid_artifact', 'Runtime probe stdout was not JSON', {
      cause: String(error),
      stderr: commandResult.stderr
    })
  }
  const validated = validateProbeArtifact(artifact, normalizedTargets)
  if (artifactPath) {
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  }
  return validated
}
function parseArgs(argv) {
  const targetsIndex = argv.indexOf('--targets')
  if (targetsIndex === -1 || !argv[targetsIndex + 1]) {
    throw new ProbeContractError('usage', 'Usage: --targets <manifest> [--artifact <path>]')
  }
  const artifactIndex = argv.indexOf('--artifact')
  return {
    targetsPath: resolve(argv[targetsIndex + 1]),
    artifactPath: artifactIndex === -1 ? null : resolve(argv[artifactIndex + 1] ?? '')
  }
}

export {
  DEFAULT_MAX_CAPSULE_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ProbeContractError,
  PROBE_SCHEMA_VERSION,
  assertLaunchProfile,
  assertProfileDriftBlocksResult,
  createContextRollover,
  createImmutableCapsule,
  createOwnedResourceScope,
  createProbeProgressTimeline,
  installProbeSignalHandlers,
  normalizeCoordinationTelemetry,
  reduceExecutionPackets,
  resolveLaunchProfile,
  runBoundedCommand,
  validateAttemptDecisionGate,
  validateTargetsManifest,
  validateBrowserEvidenceReceipt,
  validateCoordinationTelemetry,
  validateCoordinatorTimeline,
  validateDetailReference,
  validateProgressTimeline,
  validateReductionReceipt,
  validateRetainedWorkerRelease,
  validateSerialTaskReuse
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abortController = new AbortController()
  const removeSignalHandlers = installProbeSignalHandlers(abortController)
  try {
    const { targetsPath, artifactPath } = parseArgs(process.argv.slice(2))
    const targets = await readJson(targetsPath)
    await runMaestroLiveProbe({ targets, artifactPath, signal: abortController.signal })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    removeSignalHandlers()
  }
}
