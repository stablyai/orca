import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  inspectAdmissionSelector,
  selectorCellState,
  transitionAdmissionSelector
} from './relay-admission-selector.mjs'

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 14 * 60 * 1_000
const ADMIN_RETRY_ATTEMPTS = 3
const ADMIN_RETRY_BASE_MS = 250
const CONNECTION_CONTROL_REBIND_RESERVE = 100
const SUPPORTED_CONNECTION_HARD_CAPS = new Set([600, 1_000, 3_000])
const RETRYABLE_ADMIN_PATHS = new Set([
  '/v1/admin/runtime-status',
  '/v1/admin/cell-status',
  '/v1/admin/evacuation-capacity',
  '/v1/admin/evacuation-status'
])

function canonicalOrigin(value, name) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') {
    throw new Error(`${name} must be a canonical HTTPS origin`)
  }
  return value
}

function adminAudience(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/v1/admin/drain' ||
    url.search ||
    url.hash ||
    url.toString() !== value
  ) {
    throw new Error('--admin-audience must be the canonical HTTPS director drain URL')
  }
  return value
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`)
  }
  return parsed
}

export function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key ?? ''}`)
    values[key.slice(2)] = value
  }
  for (const key of [
    'project',
    'director-origin',
    'admin-audience',
    'topology-file',
    'source-cell-id',
    'target-cell-id',
    'runtime-service-account',
    'mode'
  ]) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (
    ![
      'audit',
      'preflight',
      'recover-forward',
      'continue-evacuation',
      'disable-cell',
      'execute',
      'reset-empty-candidate',
      'enable-empty-cell'
    ].includes(values.mode)
  ) {
    throw new Error(
      '--mode must be audit, preflight, recover-forward, continue-evacuation, disable-cell, execute, reset-empty-candidate, or enable-empty-cell'
    )
  }
  return {
    project: values.project,
    directorOrigin: canonicalOrigin(values['director-origin'], '--director-origin'),
    adminAudience: adminAudience(values['admin-audience']),
    topologyFile: values['topology-file'],
    sourceCellId: values['source-cell-id'],
    targetCellId: values['target-cell-id'],
    runtimeServiceAccount: values['runtime-service-account'],
    mode: values.mode,
    batchSize: positiveInteger(values['batch-size'] ?? 100, '--batch-size', 100),
    drainGraceMs: positiveInteger(
      values['drain-grace-ms'] ?? 120_000,
      '--drain-grace-ms',
      60 * 60 * 1_000
    ),
    pollIntervalMs: positiveInteger(
      values['poll-interval-ms'] ?? DEFAULT_POLL_INTERVAL_MS,
      '--poll-interval-ms',
      60_000
    ),
    timeoutMs: positiveInteger(
      values['timeout-ms'] ?? DEFAULT_TIMEOUT_MS,
      '--timeout-ms',
      60 * 60 * 1_000
    )
  }
}

export function deployment(value, cellId) {
  if (!value || typeof value !== 'object') throw new Error(`missing topology for ${cellId}`)
  const expected = {
    cellId,
    origin: canonicalOrigin(value.origin, `${cellId} origin`),
    region: String(value.region ?? 'us-central1'),
    zone: String(value.zone ?? ''),
    migName: String(value.mig_name ?? ''),
    instanceGroup: String(value.instance_group ?? ''),
    backendName: String(value.backend_name ?? ''),
    backendId: String(value.backend_id ?? ''),
    urlMapName: String(value.url_map_name ?? ''),
    generationIdentity: String(value.generation_identity ?? ''),
    image: String(value.image ?? ''),
    imageDigest: String(value.image ?? '').split('@')[1] ?? '',
    capacityRequests: positiveInteger(value.capacity_requests, `${cellId} capacity`),
    databasePoolMax: positiveInteger(
      value.database_pool_max ?? 10,
      `${cellId} database pool maximum`,
      100
    ),
    connectionHardCap:
      value.connection_hard_cap === null || value.connection_hard_cap === undefined
        ? undefined
        : positiveInteger(value.connection_hard_cap, `${cellId} connection hard cap`),
    connectionUnobservedBound:
      value.connection_unobserved_bound === null ||
      value.connection_unobserved_bound === undefined
        ? undefined
        : nonnegativeInteger(
            value.connection_unobserved_bound,
            `${cellId} unobserved connection bound`
          ),
    initiallyEnabled: value.initially_enabled,
    fenced: value.fenced,
    desiredTargetSize: value.desired_target_size
  }
  if (!/^[a-z0-9-]+$/.test(expected.zone)) throw new Error(`${cellId} has an invalid zone`)
  if (!['us-central1', 'asia-east2'].includes(expected.region) || !expected.zone.startsWith(`${expected.region}-`)) {
    throw new Error(`${cellId} has an invalid region`)
  }
  for (const [name, resource] of [
    ['MIG', expected.migName],
    ['instance group', expected.instanceGroup],
    ['backend', expected.backendName],
    ['backend ID', expected.backendId]
  ]) {
    if (!resource) throw new Error(`${cellId} has no ${name}`)
  }
  if (!/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(expected.image)) {
    throw new Error(`${cellId} image is not digest-pinned`)
  }
  if (typeof expected.initiallyEnabled !== 'boolean') {
    throw new Error(`${cellId} has no initial admission state`)
  }
  if (
    (expected.connectionHardCap === undefined) !==
      (expected.connectionUnobservedBound === undefined) ||
    (expected.connectionHardCap !== undefined &&
      (!SUPPORTED_CONNECTION_HARD_CAPS.has(expected.connectionHardCap) ||
        expected.connectionUnobservedBound >=
          expected.connectionHardCap - CONNECTION_CONTROL_REBIND_RESERVE))
  ) {
    throw new Error(`${cellId} has invalid connection capacity`)
  }
  return expected
}

export function assertDeploymentConnectionCapacity(expected, runtime, director) {
  if (expected.connectionHardCap === undefined) {
    if (runtime !== null || director !== null) {
      throw new Error(`${expected.cellId} connection capacity differs from Terraform`)
    }
    return
  }
  const hardCap = expected.connectionHardCap
  const unobservedBound = expected.connectionUnobservedBound
  const ordinaryConnectionLimit = hardCap - CONNECTION_CONTROL_REBIND_RESERVE
  const normalAdmissionPause = ordinaryConnectionLimit - unobservedBound
  const matches = (capacity) =>
    capacity?.hardCap === hardCap &&
    capacity.controlRebindReserve === CONNECTION_CONTROL_REBIND_RESERVE &&
    capacity.ordinaryConnectionLimit === ordinaryConnectionLimit &&
    capacity.unobservedBound === unobservedBound &&
    capacity.normalAdmissionPause === normalAdmissionPause
  if (!matches(runtime) || !matches(director) || director.heartbeatFresh !== true) {
    throw new Error(`${expected.cellId} connection capacity differs from Terraform`)
  }
}

export function selectDeployments(topology, sourceCellId, targetCellId) {
  if (sourceCellId === targetCellId) throw new Error('source and target cell IDs must differ')
  const source = deployment(topology[sourceCellId], sourceCellId)
  const target = deployment(topology[targetCellId], targetCellId)
  for (const key of ['origin', 'migName', 'instanceGroup', 'backendName', 'backendId']) {
    if (source[key] === target[key]) throw new Error(`source and target ${key} overlap`)
  }
  if (target.initiallyEnabled) throw new Error('candidate must be declared initially disabled')
  return { source, target }
}

export function validateMig(mig, instances, expected) {
  if (Number(mig.targetSize) !== 1) throw new Error(`${expected.cellId} MIG is not fixed-one`)
  const policy = mig.updatePolicy ?? {}
  if (
    policy.replacementMethod !== 'RECREATE' ||
    Number(policy.maxSurge?.fixed ?? policy.maxSurge) !== 0 ||
    Number(policy.maxUnavailable?.fixed ?? policy.maxUnavailable) !== 1
  ) {
    throw new Error(`${expected.cellId} MIG replacement policy is unsafe`)
  }
  const serving = instances.filter(
    (entry) => entry.instanceStatus === 'RUNNING' && entry.currentAction === 'NONE'
  )
  if (instances.length !== 1 || serving.length !== 1) {
    throw new Error(`${expected.cellId} MIG must have one running endpoint`)
  }
  return serving[0].instance.split('/').at(-1)
}

export function validateInstance(instance, expected, runtimeServiceAccount) {
  const publicConfigs = (instance.networkInterfaces ?? []).flatMap(
    (network) => network.accessConfigs ?? []
  )
  if (publicConfigs.length !== 0) throw new Error(`${expected.cellId} instance has a public IP`)
  const serviceAccounts = (instance.serviceAccounts ?? []).map((entry) => entry.email)
  if (serviceAccounts.length !== 1 || serviceAccounts[0] !== runtimeServiceAccount) {
    throw new Error(`${expected.cellId} runtime service account mismatch`)
  }
}

export function validateBackend(backend, expected) {
  if (
    backend.protocol !== 'HTTP' ||
    Number(backend.timeoutSec) !== 86_400 ||
    (backend.backends ?? []).length !== 1 ||
    backend.backends[0].group !== expected.instanceGroup
  ) {
    throw new Error(`${expected.cellId} backend topology mismatch`)
  }
}

export function defaultCommandJson(args) {
  const result = spawnSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.slice(0, 4).join(' ')} failed: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

export function suppliedAdminIdentityToken(environment = process.env) {
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  if (token === undefined) return null
  return validatedIdentityToken(token, 'admin')
}

export function suppliedFenceMutationIdentityToken(environment = process.env) {
  const token = environment.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN
  if (token === undefined) return null
  return validatedIdentityToken(token, 'fence mutation')
}

function validatedIdentityToken(token, label) {
  // WIF supplies a masked Google ID token because external-account gcloud cannot mint one directly.
  if (token.length > 8_192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`invalid supplied ${label} identity token`)
  }
  return token
}

export function defaultIdentityToken(audience) {
  const supplied = suppliedAdminIdentityToken()
  if (supplied !== null) return supplied
  const result = spawnSync(
    'gcloud',
    ['auth', 'print-identity-token', `--audiences=${audience}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (result.status !== 0) throw new Error('gcloud identity-token command failed')
  return result.stdout.trim()
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({ error: `http_${response.status}` }))
  if (!response.ok) throw new Error(`${label} failed: ${body.error ?? response.status}`)
  return body
}

export function createAdminPost(config, deps, token) {
  return async (origin, path, body) => {
    const requestToken = typeof token === 'function' ? token(path) : token
    for (let attempt = 1; attempt <= ADMIN_RETRY_ATTEMPTS; attempt++) {
      let response
      try {
        response = await deps.fetch(`${origin}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${requestToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000)
        })
      } catch (error) {
        if (!RETRYABLE_ADMIN_PATHS.has(path) || attempt === ADMIN_RETRY_ATTEMPTS) throw error
        deps.emit({ event: 'candidate_admin_retry', path, attempt, reason: 'transport' })
        await deps.wait(deps.random() * ADMIN_RETRY_BASE_MS * 2 ** (attempt - 1))
        continue
      }
      if (
        RETRYABLE_ADMIN_PATHS.has(path) &&
        ([502, 503, 504].includes(response.status) ||
          (path === '/v1/admin/evacuation-status' && response.status === 500)) &&
        attempt < ADMIN_RETRY_ATTEMPTS
      ) {
        // These endpoints are read-only or transactionally idempotent, so a
        // lost response may be retried without widening deployment authority.
        deps.emit({
          event: 'candidate_admin_retry',
          path,
          attempt,
          reason: `http_${response.status}`
        })
        await response.arrayBuffer().catch(() => undefined)
        await deps.wait(deps.random() * ADMIN_RETRY_BASE_MS * 2 ** (attempt - 1))
        continue
      }
      return await responseJson(response, path)
    }
    throw new Error(`${path} retry attempts exhausted`)
  }
}

async function checkHttp(deps, origin, path) {
  const response = await deps.fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) throw new Error(`${origin}${path} is unavailable`)
}

export async function inspectCell(config, deps, adminPost, expected) {
  const common = ['--project', config.project, '--zone', expected.zone, '--format=json']
  const mig = deps.commandJson([
    'compute',
    'instance-groups',
    'managed',
    'describe',
    expected.migName,
    ...common
  ])
  const instances = deps.commandJson([
    'compute',
    'instance-groups',
    'managed',
    'list-instances',
    expected.migName,
    ...common
  ])
  const instanceName = validateMig(mig, instances, expected)
  const instance = deps.commandJson([
    'compute',
    'instances',
    'describe',
    instanceName,
    ...common
  ])
  validateInstance(instance, expected, config.runtimeServiceAccount)
  const backend = deps.commandJson([
    'compute',
    'backend-services',
    'describe',
    expected.backendName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  validateBackend(backend, expected)
  await checkHttp(deps, expected.origin, '/health')
  await checkHttp(deps, expected.origin, '/ready')
  const runtime = await adminPost(expected.origin, '/v1/admin/runtime-status', { v: 1 })
  if (
    runtime.role !== 'cell' ||
    runtime.cellId !== expected.cellId ||
    runtime.cellUrl !== expected.origin ||
    (runtime.region ?? 'us-central1') !== expected.region ||
    runtime.imageDigest !== expected.imageDigest
  ) {
    throw new Error(`${expected.cellId} served runtime does not match Terraform topology`)
  }
  const status = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: expected.cellId
  })
  if (
    status.status?.cellUrl !== expected.origin ||
    (status.status?.region ?? 'us-central1') !== expected.region ||
    status.status?.runtime?.cellUrl !== expected.origin ||
    status.status?.runtime?.ready !== true ||
    status.status?.runtime?.heartbeatFresh !== true
  ) {
    throw new Error(`${expected.cellId} has no fresh ready authenticated heartbeat`)
  }
  assertDeploymentConnectionCapacity(
    expected,
    runtime.connectionCapacity ?? null,
    status.status.connectionCapacity ?? null
  )
  return {
    ...status.status,
    draining: runtime.draining === true,
    process: runtime.runtime ?? null,
    runtimeConnectionCapacity: runtime.connectionCapacity ?? null
  }
}

async function waitForMigration(config, deps, adminPost, completeReady) {
  const deadline = deps.now() + config.timeoutMs
  while (deps.now() < deadline) {
    const status = await adminPost(config.directorOrigin, '/v1/admin/evacuation-status', {
      v: 1,
      sourceCellId: config.sourceCellId,
      targetCellId: config.targetCellId,
      completeReady
    })
    deps.emit({ event: completeReady ? 'migration_completion' : 'migration_registration', ...status })
    if (completeReady ? status.inProgress === 0 : status.inProgress === status.targetRegistered) {
      return status
    }
    if (
      completeReady &&
      status.targetRegistered === status.inProgress &&
      status.registeredSourceActive === 0 &&
      status.registeredCompletable === 0 &&
      status.registeredTargetInactive === status.inProgress
    ) {
      // CI waiting cannot revive an offline desktop; keep its proven migration
      // pending until that target control reconnects.
      return status
    }
    await deps.wait(config.pollIntervalMs)
  }
  throw new Error('timed out waiting for candidate migration')
}

export async function setCellState(config, adminPost, cellId, enabled) {
  const post = async (path, body) => await adminPost(config.directorOrigin, path, body)
  const inspected = await inspectAdmissionSelector(post)
  if (inspected.selector.generation > 0) {
    await transitionAdmissionSelector(post, {
      [cellId]: enabled ? 'general' : 'existing-only'
    })
    return
  }
  await post('/v1/admin/cell-state', { v: 1, cellId, enabled })
}

function assertNoDurableActivity(status, operation) {
  const activity = [
    status.assignments,
    status.activityLeases,
    status.reservedRequests,
    status.outgoingMigrations,
    status.incomingMigrations
  ]
  if (activity.some((value) => Number(value) !== 0)) {
    throw new Error(`${operation} requires zero durable activity`)
  }
}

async function recoverCandidateFailure(
  config,
  deps,
  adminPost,
  source,
  target,
  allowEmptyAdmissionRollback,
  selectorActive
) {
  const status = await adminPost(config.directorOrigin, '/v1/admin/evacuation-status', {
    v: 1,
    sourceCellId: source.cellId,
    targetCellId: target.cellId,
    completeReady: false
  }).catch(() => null)
  if (!selectorActive && allowEmptyAdmissionRollback && status?.inProgress === 0) {
    await setCellState(config, adminPost, source.cellId, true).catch(() => undefined)
    await setCellState(config, adminPost, target.cellId, false).catch(() => undefined)
    return
  }
  if (!selectorActive && status && status.inProgress > 0 && status.targetRegistered === 0) {
    await setCellState(config, adminPost, source.cellId, true).catch(() => undefined)
    deps.emit({
      event: 'candidate_rollback_waiting_for_lease_expiry',
      sourceCellId: source.cellId,
      targetCellId: target.cellId,
      inProgress: status.inProgress
    })
    return
  }
  deps.emit({
    event: 'candidate_forward_recovery_required',
    sourceCellId: source.cellId,
    targetCellId: target.cellId,
    targetRegistered: status?.targetRegistered ?? null
  })
}

export async function drainSource(
  config,
  deps,
  token,
  source,
  graceMs = config.drainGraceMs,
  traceValue
) {
  const response = await deps.fetch(`${source.origin}/v1/admin/drain`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(traceValue ? { 'x-orca-drain-trace': traceValue } : {})
    },
    body: JSON.stringify({ v: 1, graceMs }),
    signal: AbortSignal.timeout(30_000)
  })
  await responseJson(response, 'source drain')
  return {
    backendStatus: response.status,
    backendInstance: response.headers.get('x-orca-backend-instance') ?? undefined
  }
}

async function verifyCandidateCompletion(
  config,
  adminPost,
  source,
  target,
  event,
  eventName = 'candidate_complete'
) {
  const finalSource = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: source.cellId
  })
  const finalTarget = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: target.cellId
  })
  if (
    finalSource.status.activityLeases !== 0 ||
    finalSource.status.reservedRequests !== 0 ||
    finalSource.status.outgoingMigrations !== 0 ||
    finalSource.status.runtime?.observedRequests !== 0 ||
    finalTarget.status.incomingMigrations !== 0 ||
    finalTarget.status.reservedRequests !== finalTarget.status.activityRequestUnits
  ) {
    throw new Error('aggregate post-migration counts are not reconciled')
  }
  event({
    event: eventName,
    sourceCellId: source.cellId,
    targetCellId: target.cellId,
    dormantSourceAssignments: finalSource.status.assignments,
    targetAssignments: finalTarget.status.assignments,
    targetActivityLeases: finalTarget.status.activityLeases,
    targetReservedRequests: finalTarget.status.reservedRequests
  })
}

export async function runCandidateDeployment(config, overrides = {}) {
  const deps = {
    commandJson: overrides.commandJson ?? defaultCommandJson,
    identityToken: overrides.identityToken ?? defaultIdentityToken,
    fetch: overrides.fetch ?? fetch,
    emit:
      overrides.emit ??
      ((event) => process.stdout.write(`${JSON.stringify(event)}\n`)),
    now: overrides.now ?? Date.now,
    wait: overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: overrides.random ?? Math.random
  }
  const topology = JSON.parse(readFileSync(config.topologyFile, 'utf8'))
  const { source, target } = selectDeployments(
    topology,
    config.sourceCellId,
    config.targetCellId
  )
  const token = deps.identityToken(config.adminAudience)
  const adminPost = createAdminPost(config, deps, token)
  const selectorPost = async (path, body) =>
    await adminPost(config.directorOrigin, path, body)
  const selectorInspection = await inspectAdmissionSelector(selectorPost)
  const selectorActive = selectorInspection.selector.generation > 0
  const sourceStatus = await inspectCell(config, deps, adminPost, source)
  const targetStatus = await inspectCell(config, deps, adminPost, target)
  const sourceAdmission = selectorActive
    ? selectorCellState(selectorInspection.selector, source.cellId)
    : sourceStatus.enabled
    ? 'general'
    : 'existing-only'
  const targetAdmission = selectorActive
    ? selectorCellState(selectorInspection.selector, target.cellId)
    : targetStatus.enabled
    ? 'general'
    : 'existing-only'
  if (config.mode === 'audit') {
    const migration = await adminPost(config.directorOrigin, '/v1/admin/evacuation-status', {
      v: 1,
      sourceCellId: source.cellId,
      targetCellId: target.cellId,
      completeReady: false
    })
    // Forward recovery needs durable aggregate evidence without exposing assignment identities.
    deps.emit({
      event: 'candidate_audit',
      source: aggregateCellStatus(sourceStatus),
      target: aggregateCellStatus(targetStatus),
      migration
    })
    return
  }
  if (config.mode === 'recover-forward') {
    if (
      selectorActive
        ? sourceAdmission !== 'existing-only' || targetAdmission !== 'migration-only'
        : sourceStatus.enabled || !targetStatus.enabled
    ) {
      throw new Error(
        selectorActive
          ? 'forward recovery requires existing-only source and migration-only target'
          : 'forward recovery requires disabled source and enabled target'
      )
    }
    await drainSource(config, deps, token, source)
    await waitForMigration(config, deps, adminPost, false)
    const completion = await waitForMigration(config, deps, adminPost, true)
    if (completion.inProgress > 0) {
      deps.emit({
        event: 'candidate_forward_pending',
        sourceCellId: source.cellId,
        targetCellId: target.cellId,
        inProgress: completion.inProgress,
        registeredSourceActive: completion.registeredSourceActive,
        registeredCompletable: completion.registeredCompletable,
        registeredTargetInactive: completion.registeredTargetInactive
      })
      throw new Error('forward recovery remains pending for inactive target controls')
    }
    await verifyCandidateCompletion(
      config,
      adminPost,
      source,
      target,
      deps.emit,
      'candidate_forward_recovered'
    )
    return
  }
  if (config.mode === 'disable-cell') {
    if (targetStatus.enabled) await setCellState(config, adminPost, target.cellId, false)
    // Disabling new admission preserves origin-owned sessions and durable recovery work.
    deps.emit({
      event: 'cell_admission_disabled',
      targetCellId: target.cellId,
      changed: targetStatus.enabled,
      assignments: targetStatus.assignments,
      activityLeases: targetStatus.activityLeases,
      reservedRequests: targetStatus.reservedRequests,
      outgoingMigrations: targetStatus.outgoingMigrations,
      incomingMigrations: targetStatus.incomingMigrations
    })
    return
  }
  // Repair is safe only before a candidate owns assignments or origin-scoped work.
  if (config.mode === 'reset-empty-candidate') {
    assertNoDurableActivity(targetStatus, 'candidate admission reset')
    if (targetStatus.enabled) await setCellState(config, adminPost, target.cellId, false)
    deps.emit({
      event: 'candidate_admission_reset',
      targetCellId: target.cellId,
      changed: targetStatus.enabled
    })
    return
  }
  if (config.mode === 'enable-empty-cell') {
    assertNoDurableActivity(targetStatus, 'cell admission enable')
    if (selectorActive ? targetAdmission === 'general' : targetStatus.enabled) {
      deps.emit({ event: 'cell_admission_enabled', targetCellId: target.cellId, changed: false })
      return
    }
  }
  const continuingEvacuation = config.mode === 'continue-evacuation'
  if (continuingEvacuation) {
    if (
      selectorActive
        ? targetAdmission !== 'migration-only'
        : !targetStatus.enabled
    ) {
      throw new Error(
        selectorActive
          ? 'continued evacuation requires migration-only target'
          : 'continued evacuation requires enabled target'
      )
    }
  } else if (!selectorActive && targetStatus.enabled) {
    throw new Error('candidate cell is already enabled')
  } else if (
    selectorActive &&
    !['migration-only', 'existing-only'].includes(targetAdmission)
  ) {
    throw new Error('candidate cell must not be generally admitted')
  }
  const capacity = await adminPost(config.directorOrigin, '/v1/admin/evacuation-capacity', {
    v: 1,
    sourceCellId: source.cellId,
    targetCellId: target.cellId
  })
  if (capacity.requiredTargetUnits > capacity.availableTargetUnits) {
    throw new Error('candidate lacks survivor request-unit headroom')
  }
  deps.emit({
    event: 'candidate_preflight',
    mode: config.mode,
    sourceCellId: source.cellId,
    targetCellId: target.cellId,
    sourceOrigin: source.origin,
    targetOrigin: target.origin,
    sourceMig: source.migName,
    targetMig: target.migName,
    sourceBackend: source.backendName,
    targetBackend: target.backendName,
    sourceDigest: source.imageDigest,
    targetDigest: target.imageDigest,
    sourceAssignments: capacity.sourceAssignments,
    requiredTargetUnits: capacity.requiredTargetUnits,
    availableTargetUnits: capacity.availableTargetUnits
  })
  if (config.mode === 'preflight') return
  if (config.mode === 'enable-empty-cell') {
    await setCellState(config, adminPost, target.cellId, true)
    deps.emit({ event: 'cell_admission_enabled', targetCellId: target.cellId, changed: true })
    return
  }
  // Fresh execution starts from source-only admission; continuation preserves its target.
  if (
    !continuingEvacuation &&
    (selectorActive ? sourceAdmission !== 'existing-only' : !sourceStatus.enabled)
  ) {
    throw new Error(
      selectorActive ? 'source cell is not existing-only' : 'source cell is not enabled'
    )
  }
  if (selectorActive && targetAdmission !== 'migration-only') {
    throw new Error('target cell is not migration-only')
  }

  let migrationsStarted = 0
  try {
    if (!selectorActive) {
      if (sourceStatus.enabled) await setCellState(config, adminPost, source.cellId, false)
      if (!targetStatus.enabled) await setCellState(config, adminPost, target.cellId, true)
    }
    for (;;) {
      const result = await adminPost(config.directorOrigin, '/v1/admin/evacuate-cell', {
        v: 1,
        sourceCellId: source.cellId,
        targetCellId: target.cellId,
        limit: config.batchSize
      })
      migrationsStarted += result.started
      deps.emit({ event: 'migration_batch', started: result.started, totalStarted: migrationsStarted })
      if (result.started === 0) break
    }
  } catch (error) {
    await recoverCandidateFailure(
      config,
      deps,
      adminPost,
      source,
      target,
      !continuingEvacuation,
      selectorActive
    )
    throw error
  }

  try {
    if (selectorActive) {
      const currentSelector = await inspectAdmissionSelector(selectorPost)
      if (
        currentSelector.selector.generation !== selectorInspection.selector.generation ||
        JSON.stringify(currentSelector.selector.membership) !==
          JSON.stringify(selectorInspection.selector.membership)
      ) {
        throw new Error('admission selector changed before drain')
      }
    }
    await drainSource(config, deps, token, source)
    await waitForMigration(config, deps, adminPost, false)
    const completion = await waitForMigration(config, deps, adminPost, true)
    if (completion.inProgress > 0) {
      throw new Error('candidate migration remains pending for inactive target controls')
    }
  } catch (error) {
    // A completion response can be lost after its transaction commits. Never
    // reverse admission here merely because no in-progress row remains.
    await recoverCandidateFailure(
      config,
      deps,
      adminPost,
      source,
      target,
      false,
      selectorActive
    )
    throw error
  }

  await verifyCandidateCompletion(config, adminPost, source, target, deps.emit)
}

export function aggregateCellStatus(status) {
  return {
    cellId: status.cellId,
    enabled: status.enabled,
    assignments: status.assignments,
    activityLeases: status.activityLeases,
    activityRequestUnits: status.activityRequestUnits,
    reservedRequests: status.reservedRequests,
    outgoingMigrations: status.outgoingMigrations,
    incomingMigrations: status.incomingMigrations,
    runtimeReady: status.runtime?.ready ?? false,
    heartbeatFresh: status.runtime?.heartbeatFresh ?? false,
    observedRequests: status.runtime?.observedRequests ?? null
  }
}

export async function main(argv = process.argv.slice(2)) {
  await runCandidateDeployment(parseArguments(argv))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
