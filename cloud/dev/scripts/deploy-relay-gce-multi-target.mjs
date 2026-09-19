import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import { pathToFileURL } from 'node:url'
import {
  aggregateCellStatus,
  assertDeploymentConnectionCapacity,
  createAdminPost,
  defaultCommandJson,
  defaultIdentityToken,
  deployment,
  drainSource,
  inspectCell,
  setCellState,
  suppliedFenceMutationIdentityToken,
  validateBackend,
  validateInstance,
  validateMig
} from './deploy-relay-gce-candidate.mjs'
import {
  abortSupersededTerraformFenceBeforeUpload,
  abortTerraformFenceBeforeApply,
  adoptLegacyTerraformFence,
  assertTerraformFenceSet,
  assertTerraformFenceZeroDiff,
  deleteTerraformFencePlan,
  downloadTerraformFencePlan,
  inspectCompletedTerraformFenceProgress,
  inspectTerraformFenceProgress,
  assertTerraformFenceStateFenced,
  readTerraformStateObjectBinding,
  recoverSupersededCompletedTerraformFence,
  resolveTerraformFencePlanGeneration,
  resumeTerraformFence,
  runTerraformFenceApply,
  uploadTerraformFencePlan
} from './relay-gce-terraform-fence.mjs'
import {
  addExactMigrationCells,
  applyExactAdmissionSelector,
  inspectAdmissionSelector,
  membershipWithStates,
  selectorCellState
} from './relay-admission-selector.mjs'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_CONNECTION_CEILING = 600
const DEFAULT_MINIMUM_LEASE_MS = 10 * 60 * 1_000
const DEFAULT_POLL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 14 * 60 * 1_000
const CUTOVER_CONNECTION_HARD_CAP = 600
const CUTOVER_CONTROL_REBIND_RESERVE = 100
const MAX_PRE_AUTH_CONNECTIONS = 45
const SELECTOR_ROLLBACK_TAG = 'selector-rollback'
const SELECTOR_REVISION_MARKER = '3'
const FENCE_BROKER_MUTATION_ROUTES = new Set([
  '/v1/admin/cell-fence-adopt-legacy',
  '/v1/admin/cell-fence-commit-legacy-adoption',
  '/v1/admin/cell-fence-attest',
  '/v1/admin/cell-fence-attempt-prepare',
  '/v1/admin/cell-fence-attempt-start',
  '/v1/admin/cell-fence-attempt-plan',
  '/v1/admin/cell-fence-attempt-operation',
  '/v1/admin/cell-fence-attempt-abort',
  '/v1/admin/migration-supersede-cell'
])

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function nonnegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be a nonnegative integer`)
  }
  return parsed
}

function canonicalOrigin(value, name) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') {
    throw new Error(`${name} must be a canonical HTTPS origin`)
  }
  return value
}

function targetIds(value, minimum) {
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].sort()
  if (ids.length < minimum || ids.some((id) => !/^[a-z][a-z0-9-]{0,127}$/.test(id))) {
    throw new Error(
      `--target-cell-ids must contain at least ${minimum} distinct cell ID${minimum === 1 ? '' : 's'}`
    )
  }
  return ids
}

function optionalCellIds(value, name) {
  const ids = [...new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
    .sort()
  if (ids.some((id) => !/^[a-z][a-z0-9-]{0,127}$/.test(id))) {
    throw new Error(`${name} contains an invalid cell ID`)
  }
  return ids
}

export function parseMultiTargetArguments(argv) {
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
    'target-cell-ids',
    'runtime-service-account',
    'mode'
  ]) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (
    ![
      'audit',
      'preflight',
      'execute',
      'cutover-admission',
      'add-migration-cells',
      'promote-general-cell',
      'retire-migration-cell',
      'recover-forward',
      'fence-source',
      'abort-fence-source',
      'supersede-target'
    ].includes(values.mode)
  ) {
    throw new Error(
      '--mode must be audit, preflight, execute, cutover-admission, add-migration-cells, promote-general-cell, retire-migration-cell, recover-forward, fence-source, abort-fence-source, or supersede-target'
    )
  }
  const singleTargetMode = [
    'add-migration-cells',
    'promote-general-cell',
    'retire-migration-cell'
  ].includes(values.mode)
  const parsedTargetIds = targetIds(values['target-cell-ids'], singleTargetMode ? 1 : 2)
  const generalCellIds = optionalCellIds(values['general-cell-ids'], '--general-cell-ids')
  const failedTargetCellId = values['failed-target-cell-id']
  const replacementTargetCellId = values['replacement-target-cell-id']
  if (
    ['promote-general-cell', 'retire-migration-cell'].includes(values.mode) &&
    parsedTargetIds.length !== 1
  ) {
    throw new Error(`${values.mode} requires exactly one target cell ID`)
  }
  if (values.mode === 'supersede-target') {
    if (!failedTargetCellId || !replacementTargetCellId) {
      throw new Error('supersede-target requires failed and replacement target cell IDs')
    }
    if (
      failedTargetCellId === replacementTargetCellId ||
      !parsedTargetIds.includes(failedTargetCellId) ||
      !parsedTargetIds.includes(replacementTargetCellId) ||
      parsedTargetIds.length !== 2
    ) {
      throw new Error('supersede-target target set must exactly match failed and replacement')
    }
  }
  const selectorMode = [
    'cutover-admission',
    'add-migration-cells',
    'promote-general-cell',
    'retire-migration-cell'
  ].includes(values.mode)
  if (selectorMode) {
    for (const key of ['director-region', 'director-service', 'director-min-instances']) {
      if (!values[key]) throw new Error(`${values.mode} requires --${key}`)
    }
    if (values.mode === 'cutover-admission' && generalCellIds.length === 0) {
      throw new Error('cutover-admission requires --general-cell-ids')
    }
    if (
      values['selector-attempt-id'] &&
      !/^[A-Za-z0-9_-]{8,128}$/.test(values['selector-attempt-id'])
    ) {
      throw new Error('--selector-attempt-id is invalid')
    }
    if (
      ['add-migration-cells', 'promote-general-cell', 'retire-migration-cell'].includes(
        values.mode
      ) &&
      !values['selector-attempt-id']
    ) {
      throw new Error(`${values.mode} requires --selector-attempt-id`)
    }
  }
  const capacityBoundModes = [
    'cutover-admission',
    'add-migration-cells',
    'recover-forward',
    'fence-source'
  ]
  if (
    capacityBoundModes.includes(values.mode) &&
    !values['unobserved-connection-bound']
  ) {
    throw new Error(`${values.mode} requires --unobserved-connection-bound`)
  }
  const adminAudience = new URL(values['admin-audience'])
  if (
    adminAudience.protocol !== 'https:' ||
    adminAudience.pathname !== '/v1/admin/drain' ||
    adminAudience.search ||
    adminAudience.hash
  ) {
    throw new Error('--admin-audience must be the director drain URL')
  }
  if (!['staging', 'production'].includes(values.environment ?? 'production')) {
    throw new Error('--environment must be staging or production')
  }
  if (
    ['fence-source', 'abort-fence-source', 'supersede-target'].includes(values.mode) &&
    !/^[a-f0-9]{40}$/.test(values['fence-commit'] ?? '')
  ) {
    throw new Error('Terraform fence modes require the exact --fence-commit')
  }
  const completedFenceFields = {
    attemptId: values['completed-fence-attempt-id'],
    fenceCommit: values['completed-fence-commit'],
    gceOperation: values['completed-fence-operation'],
    terraformStateSerial: values['completed-fence-state-serial'],
    planObjectGeneration: values['completed-fence-plan-generation'],
    terraformStateObjectGeneration: values['completed-fence-state-generation'],
    terraformStateObjectSha256: values['completed-fence-state-sha256'],
    principalEmail: values['fence-broker-service-account']
  }
  const completedFenceValues = Object.values(completedFenceFields)
  const completedFenceRecovery =
    completedFenceValues.every((value) => value === undefined)
      ? undefined
      : completedFenceFields
  if (
    completedFenceRecovery &&
    (values.mode !== 'supersede-target' ||
      completedFenceValues.some((value) => value === undefined) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        completedFenceRecovery.attemptId
      ) ||
      !/^[a-f0-9]{40}$/.test(completedFenceRecovery.fenceCommit) ||
      completedFenceRecovery.fenceCommit === values['fence-commit'] ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(completedFenceRecovery.gceOperation) ||
      !/^[1-9][0-9]{0,30}$/.test(completedFenceRecovery.planObjectGeneration) ||
      !/^[1-9][0-9]{0,30}$/.test(
        completedFenceRecovery.terraformStateObjectGeneration
      ) ||
      !/^[a-f0-9]{64}$/.test(
        completedFenceRecovery.terraformStateObjectSha256
      ) ||
      !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(
        completedFenceRecovery.principalEmail
      ))
  ) {
    throw new Error('completed Terraform fence recovery inputs are invalid')
  }
  const minimumLeaseRemainingMs = positiveInteger(
    values['minimum-lease-remaining-ms'] ?? DEFAULT_MINIMUM_LEASE_MS,
    '--minimum-lease-remaining-ms',
    60 * 60 * 1_000
  )
  if (minimumLeaseRemainingMs < DEFAULT_MINIMUM_LEASE_MS) {
    throw new Error('--minimum-lease-remaining-ms cannot be below 600000')
  }
  return {
    project: values.project,
    directorOrigin: canonicalOrigin(values['director-origin'], '--director-origin'),
    adminAudience: adminAudience.toString(),
    topologyFile: values['topology-file'],
    sourceCellId: values['source-cell-id'],
    targetCellIds: parsedTargetIds,
    generalCellIds,
    directorRegion: values['director-region'],
    directorService: values['director-service'],
    directorMinimumInstances: selectorMode
      ? positiveInteger(values['director-min-instances'], '--director-min-instances', 1_000)
      : undefined,
    selectorAttemptId: values['selector-attempt-id'],
    unobservedConnectionBound:
      capacityBoundModes.includes(values.mode)
        ? nonnegativeInteger(
            values['unobserved-connection-bound'],
            '--unobserved-connection-bound',
            CUTOVER_CONNECTION_HARD_CAP - CUTOVER_CONTROL_REBIND_RESERVE - 1
          )
        : undefined,
    failedTargetCellId,
    replacementTargetCellId,
    completedFenceRecovery: completedFenceRecovery
      ? {
          ...completedFenceRecovery,
          terraformStateSerial: nonnegativeInteger(
            completedFenceRecovery.terraformStateSerial,
            '--completed-fence-state-serial'
          )
        }
      : undefined,
    runtimeServiceAccount: values['runtime-service-account'],
    environment: values.environment ?? 'production',
    fenceCommit: values['fence-commit'],
    terraformDir: values['terraform-dir'] ?? 'infra/terraform',
    terraformVarFile:
      values['terraform-var-file'] ??
      `environments/${values.environment ?? 'production'}.tfvars`,
    mode: values.mode,
    batchSize: positiveInteger(values['batch-size'] ?? DEFAULT_BATCH_SIZE, '--batch-size', 100),
    connectionCeiling: positiveInteger(
      values['connection-ceiling'] ?? DEFAULT_CONNECTION_CEILING,
      '--connection-ceiling',
      100_000
    ),
    minimumLeaseRemainingMs,
    drainGraceMs: positiveInteger(
      values['drain-grace-ms'] ?? 120_000,
      '--drain-grace-ms',
      60 * 60 * 1_000
    ),
    pollIntervalMs: positiveInteger(
      values['poll-interval-ms'] ?? DEFAULT_POLL_MS,
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

export function selectMultiTargetDeployments(topology, sourceCellId, targetCellIds) {
  const legacyCapacityTopology = Object.values(topology).every(
    (cell) =>
      cell &&
      typeof cell === 'object' &&
      !Object.hasOwn(cell, 'connection_hard_cap') &&
      !Object.hasOwn(cell, 'connection_unobserved_bound')
  )
  const fromTopology = (cellId) => ({
    ...deployment(topology[cellId], cellId),
    legacyCapacityTopology
  })
  const source = fromTopology(sourceCellId)
  const targets = targetCellIds.map(fromTopology)
  const resources = new Map()
  for (const cell of [source, ...targets]) {
    for (const key of ['origin', 'migName', 'instanceGroup', 'backendName', 'backendId']) {
      const resourceKey = `${key}:${cell[key]}`
      const previous = resources.get(resourceKey)
      if (previous) throw new Error(`${cell.cellId} ${key} overlaps ${previous}`)
      resources.set(resourceKey, cell.cellId)
    }
  }
  if (targets.some((target) => target.initiallyEnabled)) {
    throw new Error('every target must be declared initially disabled')
  }
  return { source, targets }
}

function revisionEnvironment(revision) {
  return Object.fromEntries(
    (revision.spec?.containers?.[0]?.env ?? [])
      .filter((entry) => entry.name && 'value' in entry)
      .map((entry) => [entry.name, entry.value])
  )
}

function revisionMinimum(revision) {
  return Number(revision.metadata?.annotations?.['autoscaling.knative.dev/minScale'] ?? 0)
}

function directorInventory(environment, revisionName) {
  let cells
  try {
    cells = JSON.parse(environment.ORCA_RELAY_CELLS_JSON)
  } catch {
    throw new Error(`${revisionName} has an invalid director inventory`)
  }
  const ids = Array.isArray(cells) ? cells.map((cell) => cell?.id) : []
  if (
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`${revisionName} has an invalid director inventory`)
  }
  return JSON.stringify(cells)
}

export function verifySelectorCompatibleDirector(config, deps) {
  const common = [
    '--project',
    config.project,
    '--region',
    config.directorRegion,
    '--format=json'
  ]
  const service = deps.commandJson([
    'run',
    'services',
    'describe',
    config.directorService,
    ...common
  ])
  const active = (service.status?.traffic ?? []).filter(
    (entry) => Number(entry.percent ?? 0) > 0
  )
  const rollback = (service.status?.traffic ?? []).find(
    (entry) => entry.tag === SELECTOR_ROLLBACK_TAG
  )
  if (
    active.length !== 1 ||
    Number(active[0].percent) !== 100 ||
    !active[0].revisionName ||
    !rollback?.revisionName ||
    Number(rollback.percent ?? 0) !== 0 ||
    rollback.revisionName === active[0].revisionName
  ) {
    throw new Error('director lacks an isolated compatible rollback revision')
  }
  const revisions = deps.commandJson([
    'run',
    'revisions',
    'list',
    '--service',
    config.directorService,
    ...common
  ])
  const allowed = new Set([active[0].revisionName, rollback.revisionName])
  const names = revisions.map((revision) => revision.metadata?.name).filter(Boolean)
  if (
    revisions.length !== 2 ||
    names.length !== 2 ||
    names.some((name) => !allowed.has(name))
  ) {
    throw new Error('old or pre-selector director revisions still exist')
  }
  let compatibleImage
  let compatibleInventory
  for (const revisionName of allowed) {
    const revision = deps.commandJson([
      'run',
      'revisions',
      'describe',
      revisionName,
      ...common
    ])
    const environment = revisionEnvironment(revision)
    if (
      environment.ORCA_RELAY_ROLE !== 'director' ||
      environment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !== SELECTOR_REVISION_MARKER
    ) {
      throw new Error(`${revisionName} is not selector-compatible`)
    }
    const inventory = directorInventory(environment, revisionName)
    if (compatibleInventory && inventory !== compatibleInventory) {
      throw new Error('active and rollback director inventories do not match')
    }
    compatibleInventory = inventory
    const image = revision.spec?.containers?.[0]?.image
    if (!image || (compatibleImage && image !== compatibleImage)) {
      throw new Error('active and rollback director images do not match')
    }
    compatibleImage = image
    if (revisionName === rollback.revisionName && revisionMinimum(revision) !== 0) {
      throw new Error('selector rollback revision is not scale-to-zero')
    }
    if (
      revisionName === active[0].revisionName &&
      !(revisionMinimum(revision) >= config.directorMinimumInstances)
    ) {
      throw new Error('active selector revision is below the required floor')
    }
  }
  return {
    activeRevision: active[0].revisionName,
    rollbackRevision: rollback.revisionName
  }
}

function verifyActiveSelectorDirector(config, deps, cellId) {
  const common = [
    '--project',
    config.project,
    '--region',
    config.directorRegion,
    '--format=json'
  ]
  const service = deps.commandJson([
    'run',
    'services',
    'describe',
    config.directorService,
    ...common
  ])
  const active = (service.status?.traffic ?? []).filter(
    (entry) => Number(entry.percent ?? 0) > 0
  )
  if (
    active.length !== 1 ||
    Number(active[0].percent) !== 100 ||
    !active[0].revisionName
  ) {
    throw new Error('director lacks one active selector revision')
  }
  const revision = deps.commandJson([
    'run',
    'revisions',
    'describe',
    active[0].revisionName,
    ...common
  ])
  const environment = revisionEnvironment(revision)
  const inventory = JSON.parse(directorInventory(environment, active[0].revisionName))
  if (
    environment.ORCA_RELAY_ROLE !== 'director' ||
    environment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !== SELECTOR_REVISION_MARKER ||
    !(revisionMinimum(revision) >= config.directorMinimumInstances) ||
    !inventory.some((cell) => cell.id === cellId)
  ) {
    throw new Error('active director is not compatible with the promoted cell')
  }
  return { activeRevision: active[0].revisionName }
}

export function pruneIncompatibleDirectorRevisions(config, deps) {
  const common = [
    '--project',
    config.project,
    '--region',
    config.directorRegion,
    '--format=json'
  ]
  const service = deps.commandJson([
    'run',
    'services',
    'describe',
    config.directorService,
    ...common
  ])
  const traffic = service.status?.traffic ?? []
  const active = traffic.filter((entry) => Number(entry.percent ?? 0) > 0)
  const rollback = traffic.find((entry) => entry.tag === SELECTOR_ROLLBACK_TAG)
  const unexpectedTags = traffic.filter(
    (entry) => entry.tag && entry.tag !== SELECTOR_ROLLBACK_TAG
  )
  if (
    active.length !== 1 ||
    Number(active[0].percent) !== 100 ||
    !active[0].revisionName ||
    !rollback?.revisionName ||
    Number(rollback.percent ?? 0) !== 0 ||
    rollback.revisionName === active[0].revisionName ||
    unexpectedTags.length > 0
  ) {
    throw new Error('director traffic is not ready for selector cutover')
  }
  const activeRevision = deps.commandJson([
    'run',
    'revisions',
    'describe',
    active[0].revisionName,
    ...common
  ])
  const rollbackRevision = deps.commandJson([
    'run',
    'revisions',
    'describe',
    rollback.revisionName,
    ...common
  ])
  const activeEnvironment = revisionEnvironment(activeRevision)
  const rollbackEnvironment = revisionEnvironment(rollbackRevision)
  const activeInventory = directorInventory(activeEnvironment, active[0].revisionName)
  const rollbackInventory = directorInventory(rollbackEnvironment, rollback.revisionName)
  if (
    activeEnvironment.ORCA_RELAY_ROLE !== 'director' ||
    rollbackEnvironment.ORCA_RELAY_ROLE !== 'director' ||
    activeEnvironment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !==
      SELECTOR_REVISION_MARKER ||
    rollbackEnvironment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !==
      SELECTOR_REVISION_MARKER ||
    !activeRevision.spec?.containers?.[0]?.image ||
    activeRevision.spec?.containers?.[0]?.image !==
      rollbackRevision.spec?.containers?.[0]?.image ||
    activeInventory !== rollbackInventory ||
    revisionMinimum(rollbackRevision) !== 0 ||
    !(revisionMinimum(activeRevision) >= config.directorMinimumInstances)
  ) {
    throw new Error('director compatibility pair failed before revision pruning')
  }
  const retained = new Set([active[0].revisionName, rollback.revisionName])
  const revisions = deps.commandJson([
    'run',
    'revisions',
    'list',
    '--service',
    config.directorService,
    ...common
  ])
  for (const revision of revisions) {
    const revisionName = revision.metadata?.name
    if (!revisionName) throw new Error('director revision list contains an unnamed revision')
    if (retained.has(revisionName)) continue
    deps.command([
      'run',
      'revisions',
      'delete',
      revisionName,
      '--project',
      config.project,
      '--region',
      config.directorRegion,
      '--quiet'
    ])
  }
}

export function cutoverMembership(topology, config) {
  const all = Object.keys(topology).sort()
  const migration = new Set(config.targetCellIds)
  const general = new Set(config.generalCellIds)
  if ([...migration].some((cellId) => general.has(cellId))) {
    throw new Error('general and migration-only cell sets overlap')
  }
  if (migration.has(config.sourceCellId) || general.has(config.sourceCellId)) {
    throw new Error('cutover source must remain existing-only')
  }
  for (const cellId of [...migration, ...general]) {
    if (!all.includes(cellId)) throw new Error(`selector cell ${cellId} is absent from topology`)
  }
  return {
    existingOnly: all.filter((cellId) => !migration.has(cellId) && !general.has(cellId)),
    migrationOnly: [...migration].sort(),
    general: [...general].sort()
  }
}

function assertDistinctCutoverResources(cells) {
  const resources = new Map()
  for (const cell of cells) {
    for (const key of ['origin', 'migName', 'instanceGroup', 'backendName', 'backendId']) {
      const resourceKey = `${key}:${cell[key]}`
      const previous = resources.get(resourceKey)
      if (previous) throw new Error(`${cell.cellId} ${key} overlaps ${previous}`)
      resources.set(resourceKey, cell.cellId)
    }
  }
}

export function assertCutoverCellReady(cellId, status, unobservedConnectionBound) {
  const capacity = status.runtimeConnectionCapacity
  const directorCapacity = status.connectionCapacity
  const process = status.process
  const expectedPause =
    CUTOVER_CONNECTION_HARD_CAP -
    CUTOVER_CONTROL_REBIND_RESERVE -
    unobservedConnectionBound
  if (
    !capacity ||
    capacity.hardCap !== CUTOVER_CONNECTION_HARD_CAP ||
    capacity.controlRebindReserve !== CUTOVER_CONTROL_REBIND_RESERVE ||
    capacity.ordinaryConnectionLimit !==
      CUTOVER_CONNECTION_HARD_CAP - CUTOVER_CONTROL_REBIND_RESERVE ||
    capacity.unobservedBound !== unobservedConnectionBound ||
    capacity.normalAdmissionPause !== expectedPause ||
    !directorCapacity ||
    directorCapacity.hardCap !== capacity.hardCap ||
    directorCapacity.controlRebindReserve !== capacity.controlRebindReserve ||
    directorCapacity.ordinaryConnectionLimit !== capacity.ordinaryConnectionLimit ||
    directorCapacity.unobservedBound !== capacity.unobservedBound ||
    directorCapacity.normalAdmissionPause !== capacity.normalAdmissionPause ||
    directorCapacity.heartbeatFresh !== true ||
    expectedPause <= 0
  ) {
    throw new Error(`${cellId} does not expose the reviewed connection-capacity policy`)
  }
  if (
    !process ||
    !Number.isSafeInteger(process.enforcedConnectionUnits) ||
    process.enforcedConnectionUnits < 0 ||
    !Number.isSafeInteger(process.preAuthConnections) ||
    process.preAuthConnections < 0 ||
    !Number.isSafeInteger(directorCapacity.pendingControlReservations) ||
    directorCapacity.pendingControlReservations < 0
  ) {
    throw new Error(`${cellId} has incomplete connection-capacity evidence`)
  }
  if (process.preAuthConnections >= MAX_PRE_AUTH_CONNECTIONS) {
    throw new Error(`${cellId} has insufficient pre-auth connection headroom`)
  }
  const committedUnits =
    process.enforcedConnectionUnits + directorCapacity.pendingControlReservations
  if (!Number.isSafeInteger(committedUnits) || committedUnits >= expectedPause) {
    throw new Error(`${cellId} has insufficient normal-admission connection headroom`)
  }
  if (status.draining) throw new Error(`${cellId} is draining before selector cutover`)
}

async function inspectCutoverCells(topology, config, deps, adminPost, membership) {
  const selectedIds = [...membership.migrationOnly, ...membership.general]
  const selected = selectedIds.map((cellId) => deployment(topology[cellId], cellId))
  assertDistinctCutoverResources([
    deployment(topology[config.sourceCellId], config.sourceCellId),
    ...selected
  ])
  for (const cell of selected) {
    const status = await inspectCell(config, deps, adminPost, cell)
    assertCutoverCellReady(cell.cellId, status, config.unobservedConnectionBound)
  }
}

function projection(total, quota, assignments) {
  return assignments === 0 ? 0 : Math.ceil((total * quota) / assignments)
}

function connectionProjection(current, sourceConnections, sourceAssignments, quota) {
  const unboundConnections = Math.max(0, sourceConnections - sourceAssignments)
  return current + quota + unboundConnections
}

function targetConnectionCeiling(config, target) {
  return Math.min(
    config.connectionCeiling,
    target.connectionHardCap ?? CUTOVER_CONNECTION_HARD_CAP
  )
}

function connectionReservationHeadroom(status, cellId) {
  const capacity = status.connectionCapacity
  const values = [
    capacity?.hardCap,
    capacity?.controlRebindReserve,
    capacity?.ordinaryConnectionLimit,
    capacity?.unobservedBound,
    capacity?.normalAdmissionPause,
    capacity?.enforcedConnectionUnits,
    capacity?.pendingControlReservations
  ]
  if (
    capacity?.heartbeatFresh !== true ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    capacity.ordinaryConnectionLimit !== capacity.hardCap - capacity.controlRebindReserve ||
    capacity.normalAdmissionPause !==
      capacity.ordinaryConnectionLimit - capacity.unobservedBound
  ) {
    throw new Error(`${cellId} has inconsistent connection-reservation capacity`)
  }
  return Math.max(
    0,
    capacity.normalAdmissionPause -
      capacity.enforcedConnectionUnits -
      capacity.pendingControlReservations
  )
}

export function allocateTargetQuotas({
  sourceAssignments,
  sourceConnections,
  requiredTargetUnits,
  targets,
  connectionCeiling
}) {
  const quotas = new Map(targets.map((target) => [target.cellId, 0]))
  for (let assigned = 0; assigned < sourceAssignments; assigned++) {
    const candidates = targets
      .map((target) => {
        const quota = quotas.get(target.cellId) + 1
        const projectedConnections = connectionProjection(
          target.currentConnections,
          sourceConnections,
          sourceAssignments,
          quota
        )
        const projectedUnits = projection(requiredTargetUnits, quota, sourceAssignments)
        return { target, quota, projectedConnections, projectedUnits }
      })
      .filter(
        ({ target, quota, projectedConnections, projectedUnits }) =>
          projectedConnections < (target.connectionCeiling ?? connectionCeiling) &&
          quota <= target.availableConnectionReservations &&
          projectedUnits <= target.availableTargetUnits
      )
      .sort(
        (left, right) =>
          left.projectedConnections - right.projectedConnections ||
          left.target.cellId.localeCompare(right.target.cellId)
      )
    const selected = candidates[0]
    if (!selected) throw new Error('multi-target connection or request-unit headroom exhausted')
    quotas.set(selected.target.cellId, selected.quota)
  }
  return targets.map((target) => ({
    ...target,
    quota: quotas.get(target.cellId),
    projectedConnections: connectionProjection(
      target.currentConnections,
      sourceConnections,
      sourceAssignments,
      quotas.get(target.cellId)
    ),
    projectedUnits: projection(
      requiredTargetUnits,
      quotas.get(target.cellId),
      sourceAssignments
    )
  }))
}

function defaultCommand(args) {
  const result = spawnSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.slice(0, 5).join(' ')} failed: ${result.stderr.trim()}`)
  }
}

function defaultCommandResult(args) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function validatedProcessCounts(counts, cellId) {
  for (const field of [
    'totalConnections',
    'preAuthConnections',
    'controls',
    'splices',
    'pendingSplices',
    'queuedBytes'
  ]) {
    if (!Number.isSafeInteger(counts?.[field]) || counts[field] < 0) {
      throw new Error(`${cellId} runtime metrics have invalid ${field}`)
    }
  }
  return counts
}

function processCounts(config, deps, status, cellId) {
  if (status.process) return validatedProcessCounts(status.process, cellId)
  const filter = [
    'resource.type="gce_instance"',
    'jsonPayload.event="orca_relay_runtime_metrics"',
    `jsonPayload.cellId="${cellId}"`
  ].join(' AND ')
  const entries = deps.commandJson([
    'logging',
    'read',
    filter,
    '--project',
    config.project,
    '--freshness=5m',
    '--limit=1',
    '--order=desc',
    '--format=json'
  ])
  const entry = entries[0]
  if (!entry?.jsonPayload) throw new Error(`${cellId} has no fresh runtime metrics`)
  const timestamp = Date.parse(entry.timestamp)
  if (!Number.isFinite(timestamp) || timestamp < deps.now() - 90_000) {
    throw new Error(`${cellId} runtime metrics are stale`)
  }
  return validatedProcessCounts(entry.jsonPayload, cellId)
}

function runtimeConnections(counts, cellId) {
  const count = counts?.totalConnections
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${cellId} runtime does not expose totalConnections`)
  }
  return count
}

function runtimeIncarnation(status, cellId) {
  const incarnation = status.runtime?.cellIncarnation
  if (typeof incarnation !== 'string' || incarnation.length === 0) {
    throw new Error(`${cellId} has no exact runtime incarnation`)
  }
  return incarnation
}

async function pairStatus(config, adminPost, targetCellId, completeReady) {
  return await adminPost(config.directorOrigin, '/v1/admin/evacuation-status', {
    v: 1,
    sourceCellId: config.sourceCellId,
    targetCellId,
    completeReady
  })
}

async function allPairStatuses(config, adminPost, completeReady) {
  const statuses = []
  for (const targetCellId of config.targetCellIds) {
    statuses.push({
      targetCellId,
      status: await pairStatus(config, adminPost, targetCellId, completeReady)
    })
  }
  return statuses
}

function statusTotals(statuses) {
  return statuses.reduce(
    (totals, { status }) => ({
      inProgress: totals.inProgress + status.inProgress,
      targetRegistered: totals.targetRegistered + status.targetRegistered,
      registeredSourceActive: totals.registeredSourceActive + status.registeredSourceActive,
      registeredCompletable: totals.registeredCompletable + status.registeredCompletable,
      registeredTargetInactive:
        totals.registeredTargetInactive + status.registeredTargetInactive,
      completed: totals.completed + status.completed,
      blocked: totals.blocked + status.blocked,
      expiredUnregistered: totals.expiredUnregistered + status.expiredUnregistered,
      repairableExpiredUnregistered:
        totals.repairableExpiredUnregistered + status.repairableExpiredUnregistered,
      abortableExpiredUnregistered:
        totals.abortableExpiredUnregistered + status.abortableExpiredUnregistered,
      blockedExpiredUnregistered:
        totals.blockedExpiredUnregistered + status.blockedExpiredUnregistered,
      blockedExpiredOnNewerTargetAssignment:
        totals.blockedExpiredOnNewerTargetAssignment +
        status.blockedExpiredOnNewerTargetAssignment
    }),
    {
      inProgress: 0,
      targetRegistered: 0,
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
  )
}

function hasDurableTargetOwnership(totals) {
  return (
    totals.inProgress === totals.targetRegistered &&
    totals.targetRegistered ===
      totals.registeredSourceActive +
        totals.registeredCompletable +
        totals.registeredTargetInactive &&
    totals.registeredSourceActive === 0 &&
    totals.expiredUnregistered === 0 &&
    totals.repairableExpiredUnregistered === 0 &&
    totals.abortableExpiredUnregistered === 0 &&
    totals.blockedExpiredUnregistered === 0 &&
    totals.blockedExpiredOnNewerTargetAssignment === 0
  )
}

function boundedUnregisteredMigrations(totals, unobservedConnectionBound) {
  const unregistered = totals.inProgress - totals.targetRegistered
  return (
    Number.isSafeInteger(unobservedConnectionBound) &&
    unregistered > 0 &&
    unregistered <= unobservedConnectionBound &&
    totals.targetRegistered ===
      totals.registeredSourceActive +
        totals.registeredCompletable +
        totals.registeredTargetInactive &&
    totals.registeredSourceActive === 0 &&
    totals.blocked === 0 &&
    totals.expiredUnregistered === 0 &&
    totals.repairableExpiredUnregistered === 0 &&
    totals.abortableExpiredUnregistered === 0 &&
    totals.blockedExpiredUnregistered === 0 &&
    totals.blockedExpiredOnNewerTargetAssignment === 0
  )
}

function isSettledOrOffline(totals) {
  return (
    hasDurableTargetOwnership(totals) &&
    totals.registeredCompletable === 0 &&
    totals.blocked === totals.registeredTargetInactive
  )
}

function assertLeaseGate(statuses, minimumLeaseRemainingMs) {
  const remaining = statuses
    .map(({ status }) => status.oldestRemainingMs)
    .filter((value) => value !== null)
  if (remaining.length === 0 || Math.min(...remaining) < minimumLeaseRemainingMs) {
    throw new Error('oldest migration lease has insufficient time remaining')
  }
}

async function targetRuntime(config, adminPost, target) {
  if (config.mode !== 'fence-source') {
    const runtime = await adminPost(target.origin, '/v1/admin/runtime-status', { v: 1 })
    const count = runtime.runtime?.totalConnections
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${target.cellId} runtime does not expose totalConnections`)
    }
    if (count >= targetConnectionCeiling(config, target)) {
      throw new Error(`${target.cellId} reached the connection ceiling`)
    }
    return count
  }
  const result = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: target.cellId
  })
  const status = result.status
  if (
    status?.cellId !== target.cellId ||
    status.cellUrl !== target.origin ||
    status.runtime?.cellUrl !== target.origin ||
    status.runtime?.ready !== true ||
    status.runtime?.heartbeatFresh !== true
  ) {
    throw new Error(`${target.cellId} has no fresh matching director runtime snapshot`)
  }
  const values = [
    status.runtime.observedRequests,
    status.connectionCapacity?.observedConnections,
    status.connectionCapacity?.enforcedConnectionUnits
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${target.cellId} has incomplete director runtime counts`)
  }
  const count = Math.max(...values)
  connectionReservationHeadroom(status, target.cellId)
  if (count >= Math.min(config.connectionCeiling, status.connectionCapacity.hardCap)) {
    throw new Error(`${target.cellId} reached the connection ceiling`)
  }
  return count
}

async function checkPublicCellEndpoint(deps, cell, path) {
  const response = await deps.fetch(`${cell.origin}${path}`, {
    signal: AbortSignal.timeout(15_000)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) {
    throw new Error(`${cell.cellId} ${path} is unavailable`)
  }
}

async function inspectGeneralPromotionTarget(config, deps, adminPost, target) {
  await checkPublicCellEndpoint(deps, target, '/health')
  await checkPublicCellEndpoint(deps, target, '/ready')
  const result = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: target.cellId
  })
  const status = result.status
  if (
    status?.cellId !== target.cellId ||
    status.cellUrl !== target.origin ||
    status.runtime?.cellUrl !== target.origin ||
    status.runtime?.ready !== true ||
    status.runtime?.heartbeatFresh !== true
  ) {
    throw new Error(`${target.cellId} has no fresh matching director runtime snapshot`)
  }
  connectionReservationHeadroom(status, target.cellId)
  const currentConnections = Math.max(
    status.runtime.observedRequests,
    status.connectionCapacity.observedConnections,
    status.connectionCapacity.enforcedConnectionUnits
  )
  if (
    !Number.isSafeInteger(currentConnections) ||
    currentConnections >= targetConnectionCeiling(config, target)
  ) {
    throw new Error(`${target.cellId} reached the connection ceiling`)
  }
}

function validateReviewedInstanceTemplate(template, expected, capacityPredecessor) {
  const startupScript = (template.properties?.metadata?.items ?? [])
    .find((item) => item.key === 'startup-script')?.value
  const configuredDigest = startupScript?.match(
    /ORCA_RELAY_IMAGE_DIGEST=%s\\n' '(sha256:[a-f0-9]{64})'/
  )?.[1]
  const configuredImages = [
    ...String(startupScript ?? '').matchAll(
      /'(?:[a-z0-9.-]+\/)+[a-z0-9._/-]+@(sha256:[a-f0-9]{64})'/g
    )
  ].map((match) => match[1])
  if (
    template.selfLink !== expected.generationIdentity ||
    configuredDigest !== expected.imageDigest ||
    !configuredImages.includes(expected.imageDigest)
  ) {
    throw new Error(`${expected.cellId} instance template does not pin the reviewed image`)
  }
  const hardCaps = [
    ...String(startupScript ?? '').matchAll(
      /^  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '([0-9]+)'$/gm
    )
  ].map((match) => Number(match[1]))
  const unobservedBounds = [
    ...String(startupScript ?? '').matchAll(
      /^  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '([0-9]+)'$/gm
    )
  ].map((match) => Number(match[1]))
  const hardCap = hardCaps[0]
  const unobservedBound = unobservedBounds[0]
  const exactCapacityPredecessor =
    capacityPredecessor !== undefined &&
    hardCaps.length === 1 &&
    unobservedBounds.length === 1 &&
    hardCap === capacityPredecessor.hardCap &&
    unobservedBound === capacityPredecessor.unobservedBound
  if (expected.connectionHardCap === undefined) {
    if (!exactCapacityPredecessor && (hardCaps.length !== 0 || unobservedBounds.length !== 0)) {
      throw new Error(`${expected.cellId} instance template capacity differs from Terraform`)
    }
    return exactCapacityPredecessor
      ? {
          ...expected,
          connectionHardCap: hardCap,
          connectionUnobservedBound: unobservedBound
        }
      : expected
  }
  const isReviewedPredecessor =
    exactCapacityPredecessor && expected.connectionHardCap === 1_000
  if (
    hardCaps.length !== 1 ||
    unobservedBounds.length !== 1 ||
    !Number.isSafeInteger(hardCap) ||
    !Number.isSafeInteger(unobservedBound) ||
    (hardCap !== expected.connectionHardCap && !isReviewedPredecessor) ||
    unobservedBound !== expected.connectionUnobservedBound
  ) {
    throw new Error(`${expected.cellId} instance template capacity is outside reviewed rollout`)
  }
  return {
    ...expected,
    connectionHardCap: hardCap,
    connectionUnobservedBound: unobservedBound
  }
}

async function inspectDirectorObservedCell(config, deps, adminPost, expected) {
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
  if (
    mig.instanceTemplate !== expected.generationIdentity ||
    instances[0]?.version?.instanceTemplate !== expected.generationIdentity
  ) {
    throw new Error(`${expected.cellId} MIG does not serve the reviewed generation`)
  }
  const instance = deps.commandJson([
    'compute',
    'instances',
    'describe',
    instanceName,
    ...common
  ])
  validateInstance(instance, expected, config.runtimeServiceAccount)
  const templateName = new URL(expected.generationIdentity).pathname.split('/').at(-1)
  const template = deps.commandJson([
    'compute',
    'instance-templates',
    'describe',
    templateName,
    '--project',
    config.project,
    '--format=json'
  ])
  const deployed = validateReviewedInstanceTemplate(
    template,
    expected,
    config.mode === 'fence-source' &&
      (expected.connectionHardCap !== undefined || expected.legacyCapacityTopology)
      ? {
          hardCap: config.connectionCeiling,
          unobservedBound: config.unobservedConnectionBound
        }
      : undefined
  )
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
  await assertCellRoute(config, deps, expected)
  await checkPublicCellEndpoint(deps, expected, '/health')
  await checkPublicCellEndpoint(deps, expected, '/ready')
  const result = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: expected.cellId
  })
  const status = result.status
  if (
    status?.cellId !== expected.cellId ||
    status.cellUrl !== expected.origin ||
    status.runtime?.cellUrl !== expected.origin ||
    status.runtime?.ready !== true ||
    status.runtime?.heartbeatFresh !== true
  ) {
    throw new Error(`${expected.cellId} has no fresh matching director runtime snapshot`)
  }
  connectionReservationHeadroom(status, expected.cellId)
  assertDeploymentConnectionCapacity(
    deployed,
    status.connectionCapacity ?? null,
    status.connectionCapacity ?? null
  )
  const connectionValues = [
    status.runtime.observedRequests,
    status.connectionCapacity.observedConnections,
    status.connectionCapacity.enforcedConnectionUnits
  ]
  if (connectionValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${expected.cellId} has incomplete director runtime counts`)
  }
  const currentConnections = Math.max(...connectionValues)
  if (currentConnections >= targetConnectionCeiling(config, deployed)) {
    throw new Error(`${expected.cellId} reached the connection ceiling`)
  }
  return {
    ...status,
    process: { totalConnections: currentConnections }
  }
}

async function waitForMultiStatus(
  config,
  deps,
  adminPost,
  targets,
  completeReady,
  allowBoundedUnregistered = false,
  requireZero = false
) {
  const deadline = deps.now() + config.timeoutMs
  while (deps.now() < deadline) {
    const statuses = await allPairStatuses(config, adminPost, completeReady)
    for (const target of targets) await targetRuntime(config, adminPost, target)
    const totals = statusTotals(statuses)
    deps.emit({
      event: completeReady ? 'multi_migration_completion' : 'multi_migration_registration',
      ...totals
    })
    const boundedUnregistered =
      allowBoundedUnregistered &&
      boundedUnregisteredMigrations(totals, config.unobservedConnectionBound)
    const boundedSettlement = boundedUnregistered && totals.registeredCompletable === 0
    if (
      completeReady
        ? (requireZero
            ? totals.inProgress === 0
            : isSettledOrOffline(totals) || boundedSettlement)
        : totals.inProgress === totals.targetRegistered || boundedUnregistered
    ) {
      if (boundedUnregistered) {
        deps.emit({
          event: completeReady
            ? 'multi_migration_bounded_offline_complete'
            : 'multi_migration_bounded_offline_registered',
          unobservedConnectionBound: config.unobservedConnectionBound,
          unregistered: totals.inProgress - totals.targetRegistered,
          ...totals
        })
      }
      return statuses
    }
    await deps.wait(config.pollIntervalMs)
  }
  throw new Error(
    completeReady
      ? 'timed out waiting for multi-target completion'
      : 'timed out waiting for multi-target registration'
  )
}

async function waitForRecoveredSourceZero(
  config,
  deps,
  adminPost,
  source,
  expectedIncarnation
) {
  const deadline = deps.now() + config.timeoutMs
  while (deps.now() < deadline) {
    const status = await inspectCell(config, deps, adminPost, source)
    const counts = processCounts(config, deps, status, source.cellId)
    deps.emit({
      event: 'source_recovery_runtime_settlement',
      draining: status.draining,
      activityLeases: status.activityLeases,
      reservedRequests: status.reservedRequests,
      controls: counts.controls,
      splices: counts.splices,
      pendingSplices: counts.pendingSplices
    })
    if (
      runtimeIncarnation(status, source.cellId) !== expectedIncarnation
    ) {
      throw new Error('source incarnation changed during recovery settlement')
    }
    if (
      status.draining &&
      status.activityLeases === 0 &&
      status.reservedRequests === 0 &&
      counts.controls === 0 &&
      counts.splices === 0 &&
      counts.pendingSplices === 0
    ) {
      return
    }
    await deps.wait(config.pollIntervalMs)
  }
  throw new Error('timed out waiting for recovered source runtime to reach zero')
}

async function rollbackBeforeDrain(config, deps, adminPost, targets, selectorActive) {
  let statuses
  try {
    statuses = await allPairStatuses(config, adminPost, false)
  } catch (error) {
    deps.emit({
      event: 'multi_forward_recovery_required',
      targetRegistered: null,
      reason: 'registration_status_unavailable'
    })
    throw new Error('cannot prove zero target registrations; preserving forward recovery', {
      cause: error
    })
  }
  const totals = statusTotals(statuses)
  if (totals.targetRegistered > 0) {
    deps.emit({ event: 'multi_forward_recovery_required', ...totals })
    return
  }
  if (selectorActive) {
    deps.emit({ event: 'multi_rollback_preserved_selector', ...totals })
    return
  }
  await setCellState(config, adminPost, config.sourceCellId, true).catch(() => undefined)
  for (const target of targets) {
    await setCellState(config, adminPost, target.cellId, false).catch(() => undefined)
  }
  deps.emit({ event: 'multi_rollback_waiting_for_lease_expiry', ...totals })
}

async function publishMigrations(config, deps, adminPost, plannedTargets) {
  for (const target of plannedTargets) {
    let remaining = target.quota
    while (remaining > 0) {
      const limit = Math.min(config.batchSize, remaining)
      let result
      try {
        result = await adminPost(config.directorOrigin, '/v1/admin/evacuate-cell', {
          v: 1,
          sourceCellId: config.sourceCellId,
          targetCellId: target.cellId,
          limit
        })
      } catch (error) {
        if (
          config.mode !== 'recover-forward' ||
          !(error instanceof Error) ||
          error.message !==
            '/v1/admin/evacuate-cell failed: relay_connection_headroom_exhausted'
        ) {
          throw error
        }
        deps.emit({
          event: 'multi_recovery_target_headroom_paused',
          targetCellId: target.cellId,
          remaining
        })
        break
      }
      if (
        !Number.isSafeInteger(result.started) ||
        result.started < 0 ||
        result.started > limit
      ) {
        throw new Error(`${target.cellId} migration quota could not be filled deterministically`)
      }
      if (result.started === 0 && config.mode === 'recover-forward') {
        deps.emit({
          event: 'multi_recovery_quota_depleted',
          targetCellId: target.cellId,
          remaining
        })
        break
      }
      if (result.started === 0) {
        throw new Error(`${target.cellId} migration quota could not be filled deterministically`)
      }
      remaining -= result.started
      deps.emit({
        event: 'multi_migration_batch',
        targetCellId: target.cellId,
        started: result.started,
        remaining
      })
    }
  }
}

function sourceMig(config, deps, source) {
  const common = ['--project', config.project, '--zone', source.zone, '--format=json']
  return {
    mig: deps.commandJson([
      'compute',
      'instance-groups',
      'managed',
      'describe',
      source.migName,
      ...common
    ]),
    instances: deps.commandJson([
      'compute',
      'instance-groups',
      'managed',
      'list-instances',
      source.migName,
      ...common
    ])
  }
}

function validateFencedMig(mig, source) {
  const policy = mig.updatePolicy ?? {}
  if (
    Number(mig.targetSize) !== 0 ||
    mig.instanceTemplate !== source.generationIdentity ||
    policy.replacementMethod !== 'RECREATE' ||
    Number(policy.maxSurge?.fixed ?? policy.maxSurge) !== 0 ||
    Number(policy.maxUnavailable?.fixed ?? policy.maxUnavailable) !== 1
  ) {
    throw new Error(`${source.cellId} MIG fence topology is unsafe`)
  }
}

function canonicalBackendServiceId(value) {
  if (typeof value !== 'string') return null
  const prefix = 'https://www.googleapis.com/compute/v1/'
  const resource = value.startsWith(prefix) ? value.slice(prefix.length) : value
  return /^projects\/[a-z][a-z0-9-]{4,29}\/global\/backendServices\/[A-Za-z0-9_-]{1,63}$/.test(
    resource
  )
    ? resource
    : null
}

export function sameBackendServiceResource(left, right) {
  if (left === right) return true
  const leftId = canonicalBackendServiceId(left)
  return leftId !== null && leftId === canonicalBackendServiceId(right)
}

function validateRetainedRoute(urlMap, source) {
  const hostname = new URL(source.origin).hostname
  const hostRule = (urlMap.hostRules ?? []).find((rule) =>
    (rule.hosts ?? []).includes(hostname)
  )
  const matcher = (urlMap.pathMatchers ?? []).find(
    (candidate) => candidate.name === hostRule?.pathMatcher
  )
  if (
    !source.urlMapName ||
    urlMap.name !== source.urlMapName ||
    !sameBackendServiceResource(matcher?.defaultService, source.backendId) ||
    (matcher.pathRules?.length ?? 0) !== 0 ||
    (matcher.routeRules?.length ?? 0) !== 0 ||
    matcher.defaultRouteAction !== undefined ||
    matcher.defaultUrlRedirect !== undefined ||
    matcher.headerAction !== undefined
  ) {
    throw new Error(`${source.cellId} retained route topology mismatch`)
  }
}

async function assertCellRoute(config, deps, cell) {
  const urlMap = deps.commandJson([
    'compute',
    'url-maps',
    'describe',
    cell.urlMapName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  validateRetainedRoute(urlMap, cell)
  const proxy = deps.commandJson([
    'compute',
    'target-https-proxies',
    'describe',
    cell.urlMapName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  const forwardingRule = deps.commandJson([
    'compute',
    'forwarding-rules',
    'describe',
    cell.urlMapName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  const address = deps.commandJson([
    'compute',
    'addresses',
    'describe',
    cell.urlMapName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  const resolved = await deps.resolve4(new URL(cell.origin).hostname)
  if (
    proxy.name !== cell.urlMapName ||
    proxy.urlMap !== urlMap.selfLink ||
    forwardingRule.name !== cell.urlMapName ||
    forwardingRule.target !== proxy.selfLink ||
    forwardingRule.IPAddress !== address.address ||
    forwardingRule.portRange !== '443-443' ||
    forwardingRule.loadBalancingScheme !== 'EXTERNAL_MANAGED' ||
    !Array.isArray(resolved) ||
    resolved.length === 0 ||
    resolved.some((value) => value !== address.address)
  ) {
    throw new Error(`${cell.cellId} live frontend topology mismatch`)
  }
}

async function inspectFencedSource(config, deps, adminPost, source, mig) {
  validateFencedMig(mig, source)
  const backend = deps.commandJson([
    'compute',
    'backend-services',
    'describe',
    source.backendName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  validateBackend(backend, source)
  await assertCellRoute(config, deps, source)
  const result = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: source.cellId
  })
  const status = result.status
  if (
    status?.cellUrl !== source.origin ||
    (status.runtime !== null && status.runtime?.cellUrl !== source.origin)
  ) {
    throw new Error(`${source.cellId} fenced runtime does not match Terraform topology`)
  }
  return { ...status, draining: true, process: null }
}

async function inspectFenceCandidate(config, deps, adminPost, cell, mig) {
  const targetSize = Number(mig.targetSize)
  const policy = mig.updatePolicy ?? {}
  if (
    ![0, 1].includes(targetSize) ||
    policy.replacementMethod !== 'RECREATE' ||
    Number(policy.maxSurge?.fixed ?? policy.maxSurge) !== 0 ||
    Number(policy.maxUnavailable?.fixed ?? policy.maxUnavailable) !== 1
  ) {
    throw new Error(`${cell.cellId} MIG fence topology is unsafe`)
  }
  const backend = deps.commandJson([
    'compute',
    'backend-services',
    'describe',
    cell.backendName,
    '--global',
    '--project',
    config.project,
    '--format=json'
  ])
  validateBackend(backend, cell)
  const result = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: cell.cellId
  })
  if (
    result.status?.cellUrl !== cell.origin ||
    result.status.runtime?.cellUrl !== cell.origin
  ) {
    throw new Error(`${cell.cellId} retained topology does not match Terraform`)
  }
  return result.status
}

const CAPACITY_SNAPSHOT_ATTEMPTS = 3
const CAPACITY_SNAPSHOT_RETRY_MS = 250
const RECOVERY_CATCH_UP_PASSES = 5
const RECOVERY_TARGET_OWNERSHIP_TIMEOUT_MS = 2 * 60 * 1_000

function conservativeRecoveryCapacity(rounds, targets, requireZeroProof) {
  const capacities = rounds.flat()
  for (const capacity of capacities) {
    if (
      !Number.isSafeInteger(capacity.sourceAssignments) ||
      capacity.sourceAssignments < 0 ||
      !Number.isSafeInteger(capacity.requiredTargetUnits) ||
      capacity.requiredTargetUnits < capacity.sourceAssignments ||
      !Number.isSafeInteger(capacity.availableTargetUnits) ||
      capacity.availableTargetUnits < 0
    ) {
      throw new Error('target capacity snapshot is internally inconsistent')
    }
  }
  const observedSourceAssignments = capacities.map(
    (capacity) => capacity.sourceAssignments
  )
  const sourceAssignments = requireZeroProof
    ? Math.max(...observedSourceAssignments)
    : Math.min(...observedSourceAssignments)
  const requiredTargetUnits =
    sourceAssignments === 0
      ? 0
      : requireZeroProof
        ? Math.max(...capacities.map((capacity) => capacity.requiredTargetUnits))
        : Math.max(
          ...capacities.map((capacity) =>
            Math.ceil(
              sourceAssignments *
                (capacity.requiredTargetUnits / capacity.sourceAssignments)
            )
          )
        )
  return {
    sourceAssignments,
    requiredTargetUnits,
    availableTargetUnits: new Map(targets.map((target, index) => [
      target.cellId,
      Math.min(...rounds.map((round) => round[index].availableTargetUnits))
    ]))
  }
}

async function readTargetCapacitySnapshot(
  config,
  deps,
  adminPost,
  source,
  targets,
  requireRecoveryZeroProof = false
) {
  for (let attempt = 0; attempt < CAPACITY_SNAPSHOT_ATTEMPTS; attempt++) {
    const rounds = []
    for (let round = 0; round < 2; round++) {
      const capacities = []
      for (const target of targets) {
        capacities.push(await adminPost(
          config.directorOrigin,
          '/v1/admin/evacuation-capacity',
          { v: 1, sourceCellId: source.cellId, targetCellId: target.cellId }
        ))
      }
      rounds.push(capacities)
    }
    if (config.mode === 'recover-forward') {
      return conservativeRecoveryCapacity(rounds, targets, requireRecoveryZeroProof)
    }
    const capacities = rounds.flat()
    const baseline = capacities[0]
    if (capacities.every((capacity) =>
      capacity.sourceAssignments === baseline.sourceAssignments &&
      capacity.requiredTargetUnits === baseline.requiredTargetUnits
    )) {
      return {
        sourceAssignments: baseline.sourceAssignments,
        requiredTargetUnits: baseline.requiredTargetUnits,
        availableTargetUnits: new Map(targets.map((target, index) => [
          target.cellId,
          Math.min(...rounds.map((round) => round[index].availableTargetUnits))
        ]))
      }
    }
    if (attempt + 1 < CAPACITY_SNAPSHOT_ATTEMPTS) {
      await deps.wait(CAPACITY_SNAPSHOT_RETRY_MS)
    }
  }
  throw new Error('target capacity snapshots disagree')
}

async function preflight(
  config,
  deps,
  adminPost,
  source,
  targets,
  sourceFence = null,
  selector = null,
  coveredSourceConnections = null
) {
  const sourceStatus = sourceFence
    ? await inspectFencedSource(config, deps, adminPost, source, sourceFence.mig)
    : config.mode === 'fence-source'
      ? {
          ...await inspectDirectorObservedCell(config, deps, adminPost, source),
          process: null
        }
      : await inspectCell(config, deps, adminPost, source)
  const sourceProcess = sourceFence
    ? null
    : processCounts(config, deps, sourceStatus, source.cellId)
  const targetStatuses = []
  for (const target of targets) {
    const status = config.mode === 'fence-source'
      ? {
          ...await inspectDirectorObservedCell(config, deps, adminPost, target),
          process: null
        }
      : await inspectCell(config, deps, adminPost, target)
    const targetProcess = processCounts(config, deps, status, target.cellId)
    const targetAdmission = selector
      ? selectorCellState(selector, target.cellId)
      : status.enabled
      ? 'general'
      : 'existing-only'
    if (
      ['preflight', 'execute'].includes(config.mode) &&
      (selector ? targetAdmission === 'general' : status.enabled)
    ) {
      throw new Error(`${target.cellId} must not start in general admission`)
    }
    targetStatuses.push({
      ...target,
      status,
      process: targetProcess,
      currentConnections: runtimeConnections(targetProcess, target.cellId),
      availableConnectionReservations: connectionReservationHeadroom(
        status,
        target.cellId
      ),
      connectionCeiling: Math.min(
        config.connectionCeiling,
        status.connectionCapacity.hardCap
      )
    })
  }
  if (config.mode === 'audit' || config.mode === 'recover-forward') {
    const statuses = await allPairStatuses(config, adminPost, false)
    deps.emit({
      event: config.mode === 'audit' ? 'multi_target_audit' : 'multi_forward_recovery_preflight',
      ...statusTotals(statuses)
    })
    if (config.mode === 'audit') {
      return {
        sourceProcess,
        sourceStatus,
        plannedTargets: targetStatuses,
        sourceAlreadyFenced: Boolean(sourceFence)
      }
    }
  }
  const capacity = await readTargetCapacitySnapshot(
    config,
    deps,
    adminPost,
    source,
    targets
  )
  const { sourceAssignments, requiredTargetUnits } = capacity
  const observedSourceConnections = sourceFence
    ? 0
    : runtimeConnections(sourceProcess, source.cellId)
  const sourceConnections =
    coveredSourceConnections === null
      ? observedSourceConnections
      : sourceAssignments +
        Math.max(0, observedSourceConnections - coveredSourceConnections)
  for (const target of targetStatuses) {
    target.availableTargetUnits = capacity.availableTargetUnits.get(target.cellId)
  }
  deps.emit({
    event: 'multi_target_capacity_snapshot',
    sourceConnections,
    observedSourceConnections,
    sourceAssignments,
    requiredTargetUnits,
    targets: targetStatuses.map((target) => ({
      cellId: target.cellId,
      currentConnections: target.currentConnections,
      availableConnectionReservations: target.availableConnectionReservations,
      availableTargetUnits: target.availableTargetUnits
    }))
  })
  if (
    config.mode === 'execute' &&
    (selector
      ? selectorCellState(selector, source.cellId) !== 'existing-only'
      : !sourceStatus.enabled)
  ) {
    throw new Error(selector ? 'source cell is not existing-only' : 'source cell is not enabled')
  }
  const plannedTargets = allocateTargetQuotas({
    sourceAssignments,
    sourceConnections,
    requiredTargetUnits,
    targets: targetStatuses,
    connectionCeiling: config.connectionCeiling
  })
  deps.emit({
    event: 'multi_target_preflight',
    source: aggregateCellStatus(sourceStatus),
    sourceConnections,
    observedSourceConnections,
    sourceAssignments,
    targets: plannedTargets.map((target) => ({
      cellId: target.cellId,
      quota: target.quota,
      currentConnections: target.currentConnections,
      projectedConnections: target.projectedConnections,
      projectedUnits: target.projectedUnits
    }))
  })
  return { sourceProcess, sourceStatus, plannedTargets, sourceAlreadyFenced: Boolean(sourceFence) }
}

async function assertRecoveryPreDrain(
  config,
  deps,
  adminPost,
  source,
  targets,
  selectorPost,
  expectedSelector
) {
  const statuses = await allPairStatuses(config, adminPost, false)
  const totals = statusTotals(statuses)
  const capacity = await readTargetCapacitySnapshot(
    config,
    deps,
    adminPost,
    source,
    targets,
    true
  )
  if (capacity.sourceAssignments !== 0 || capacity.requiredTargetUnits !== 0) {
    deps.emit({
      event: 'multi_forward_recovery_catch_up',
      sourceAssignments: capacity.sourceAssignments,
      requiredTargetUnits: capacity.requiredTargetUnits
    })
    return false
  }
  for (const target of targets) await targetRuntime(config, adminPost, target)
  if (expectedSelector) {
    const current = await inspectAdmissionSelector(selectorPost)
    if (
      current.selector.generation !== expectedSelector.generation ||
      JSON.stringify(current.selector.membership) !==
        JSON.stringify(expectedSelector.membership)
    ) {
      throw new Error('admission selector changed before recovery drain')
    }
  }
  deps.emit({
    event: 'multi_forward_recovery_ready_to_drain',
    ...totals
  })
  return true
}

async function waitForRecoveryTargetOwnership(config, deps, adminPost, targets) {
  const deadline =
    deps.now() + Math.min(config.timeoutMs, RECOVERY_TARGET_OWNERSHIP_TIMEOUT_MS)
  while (deps.now() < deadline) {
    const statuses = await allPairStatuses(config, adminPost, false)
    for (const target of targets) await targetRuntime(config, adminPost, target)
    const totals = statusTotals(statuses)
    deps.emit({ event: 'multi_recovery_target_ownership', ...totals })
    assertLeaseGate(statuses, config.minimumLeaseRemainingMs)
    if (hasDurableTargetOwnership(totals)) return
    if (boundedUnregisteredMigrations(totals, config.unobservedConnectionBound)) {
      const unregistered = totals.inProgress - totals.targetRegistered
      deps.emit({
        event:
          totals.targetRegistered === 0
            ? 'multi_recovery_bounded_unregistered'
            : 'multi_recovery_bounded_mixed_registration',
        unobservedConnectionBound: config.unobservedConnectionBound,
        unregistered,
        ...totals
      })
      return
    }
    await deps.wait(config.pollIntervalMs)
  }
  throw new Error('timed out waiting for recovery target ownership')
}

async function runEvacuation(
  config,
  deps,
  adminPost,
  token,
  source,
  targets,
  plannedTargets,
  sourceStatus,
  selectorActive,
  selectorPost,
  expectedSelector
) {
  let drainAttempted = false
  try {
    if (!selectorActive) {
      await setCellState(config, adminPost, source.cellId, false)
      for (const target of targets) await setCellState(config, adminPost, target.cellId, true)
    }
    await publishMigrations(config, deps, adminPost, plannedTargets)
    const statuses = await allPairStatuses(config, adminPost, false)
    assertLeaseGate(statuses, config.minimumLeaseRemainingMs)
    for (const target of targets) await targetRuntime(config, adminPost, target)
    if (selectorActive) {
      const current = await inspectAdmissionSelector(selectorPost)
      if (
        current.selector.generation !== expectedSelector.generation ||
        JSON.stringify(current.selector.membership) !==
          JSON.stringify(expectedSelector.membership)
      ) {
        throw new Error('admission selector changed before drain')
      }
    }
    const attemptId = randomUUID()
    const traceValue = randomUUID()
    const prepared = await adminPost(
      config.directorOrigin,
      '/v1/admin/drain-attempt-prepare',
      {
        v: 1,
        attemptId,
        cellId: source.cellId,
        cellIncarnation: runtimeIncarnation(sourceStatus, source.cellId),
        traceValue,
        graceMs: 120_000,
        confirmation: 'PREPARE_LEGACY_DRAIN'
      }
    )
    if (prepared.state !== 'prepared') {
      throw new Error('planned drain already recorded; use recover-forward')
    }
    drainAttempted = true
    const sending = await adminPost(
      config.directorOrigin,
      '/v1/admin/drain-attempt-send',
      {
        v: 1,
        attemptId,
        cellId: source.cellId,
        cellIncarnation: runtimeIncarnation(sourceStatus, source.cellId)
      }
    )
    if (
      sending.attempt?.state !== 'send-may-have-started' ||
      sending.attempt.shouldSend !== true ||
      !Number.isSafeInteger(sending.attempt.sendPermitExpiresAt) ||
      deps.now() >= sending.attempt.sendPermitExpiresAt
    ) {
      throw new Error('drain send permit unavailable')
    }
    const receipt = await drainSource(config, deps, token, source, 120_000, traceValue)
    await adminPost(config.directorOrigin, '/v1/admin/drain-attempt-receipt', {
      v: 1,
      attemptId,
      cellId: source.cellId,
      cellIncarnation: runtimeIncarnation(sourceStatus, source.cellId),
      traceValue,
      ...receipt
    })
    deps.emit({ event: 'source_drain_accepted', sourceCellId: source.cellId })
    await waitForMultiStatus(config, deps, adminPost, targets, false)
    await waitForMultiStatus(config, deps, adminPost, targets, true)
    deps.emit({ event: 'multi_target_complete', sourceCellId: source.cellId })
  } catch (error) {
    if (drainAttempted) {
      const statuses = await allPairStatuses(config, adminPost, false).catch(() => [])
      deps.emit({ event: 'multi_forward_recovery_required', ...statusTotals(statuses) })
    } else {
      await rollbackBeforeDrain(config, deps, adminPost, targets, selectorActive)
    }
    throw error
  }
}

async function waitForFence(config, deps, adminPost, source) {
  const deadline = deps.now() + config.timeoutMs
  while (deps.now() < deadline) {
    const mig = deps.commandJson([
      'compute',
      'instance-groups',
      'managed',
      'describe',
      source.migName,
      '--project',
      config.project,
      '--zone',
      source.zone,
      '--format=json'
    ])
    const instances = deps.commandJson([
      'compute',
      'instance-groups',
      'managed',
      'list-instances',
      source.migName,
      '--project',
      config.project,
      '--zone',
      source.zone,
      '--format=json'
    ])
    const status = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
      v: 1,
      cellId: source.cellId
    })
    if (
      Number(mig.targetSize) === 0 &&
      instances.length === 0 &&
      status.status?.cellUrl === source.origin &&
      status.status.enabled === false &&
      !status.status.runtime?.heartbeatFresh
    ) {
      const incarnation = status.status.runtime?.cellIncarnation
      if (typeof incarnation !== 'string' || incarnation.length === 0) {
        throw new Error('fenced source has no exact runtime incarnation')
      }
      return incarnation
    }
    await deps.wait(config.pollIntervalMs)
  }
  throw new Error('timed out waiting for durable source fence')
}

function terraformFenceConfig(config, cell, cellIncarnation) {
  return {
    project: config.project,
    environment: config.environment,
    terraformDir: config.terraformDir,
    varFile: config.terraformVarFile,
    lockTimeout: '5m',
    fenceCommit: config.fenceCommit,
    cellIncarnation,
    cell
  }
}

function fenceAttemptBody(attempt) {
  return {
    v: 1,
    attemptId: attempt.attemptId,
    environment: attempt.environment,
    cellId: attempt.cellId,
    cellIncarnation: attempt.cellIncarnation,
    migName: attempt.migName,
    instanceGroup: attempt.instanceGroup,
    generationIdentity: attempt.generationIdentity,
    fenceCommit: attempt.fenceCommit,
    planSha256: attempt.planSha256,
    planObjectName: attempt.planObjectName,
    planObjectGeneration: attempt.planObjectGeneration,
    varFileSha256: attempt.varFileSha256,
    terraformStateLineage: attempt.terraformStateLineage,
    terraformStateSerial: attempt.terraformStateSerial,
    terraformStateObjectGeneration: attempt.terraformStateObjectGeneration,
    terraformStateObjectSha256: attempt.terraformStateObjectSha256,
    requestReason: attempt.requestReason,
    ...(attempt.gceOperation ? { gceOperation: attempt.gceOperation } : {})
  }
}

async function runTerraformManagedFence(
  config,
  deps,
  adminPost,
  cell,
  cellIncarnation,
  alreadyFenced,
  preApplyGuard,
  postApplyGuard
) {
  const fenceConfig = terraformFenceConfig(config, cell, cellIncarnation)
  const inspectProgress = async (_expected, attempt) =>
    await inspectTerraformFenceProgress(
      fenceConfig,
      {
        terraform: deps.terraform,
        gcloudJson: deps.commandJson
      },
      attempt
    )
  const attest = async (attempt) => {
    await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attest', {
      ...fenceAttemptBody(attempt),
      confirmation: 'ATTEST_TERRAFORM_FENCED_CELL'
    })
  }
  const attemptResult = await adminPost(
    config.directorOrigin,
    '/v1/admin/cell-fence-attempt-status',
    { v: 1, cellId: cell.cellId }
  )
  let existingAttempt = attemptResult.attempt
  const planStore = {
    uploadPlan: async (planPath, attempt) =>
      await uploadTerraformFencePlan(
        fenceConfig,
        { command: deps.command, commandJson: deps.commandJson },
        planPath,
        attempt
      ),
    downloadPlan: async (attempt, planPath) =>
      await downloadTerraformFencePlan(
        fenceConfig,
        { command: deps.command },
        attempt,
        planPath
      ),
    deletePlan: async (attempt) =>
      await deleteTerraformFencePlan(
        fenceConfig,
        { commandResult: deps.commandResult },
        attempt
      ),
    stateObjectBinding: async (statePath) =>
      await readTerraformStateObjectBinding(
        fenceConfig,
        { command: deps.command, commandJson: deps.commandJson },
        statePath
      )
  }
  if (
    existingAttempt &&
    existingAttempt.fenceCommit !== config.fenceCommit &&
    config.completedFenceRecovery
  ) {
    await deps.terraformFenceRecoverCompleted(
      fenceConfig,
      {
        terraform: deps.terraform,
        assertCommittedFenceSet: async () =>
          assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
        loadAttempt: async () => existingAttempt,
        resolvePlan: async (attempt) =>
          await resolveTerraformFencePlanGeneration(
            fenceConfig,
            { commandResult: deps.commandResult },
            attempt
          ),
        stateObjectBinding: planStore.stateObjectBinding,
        downloadPlan: planStore.downloadPlan,
        deletePlan: planStore.deletePlan,
        inspectCompletedProgress: async (_expected, attempt, recovery) =>
          await inspectCompletedTerraformFenceProgress(
            fenceConfig,
            {
              terraform: deps.terraform,
              gcloudJson: deps.commandJson
            },
            attempt,
            recovery
          ),
        markOperation: async (attempt, invocation) =>
          await adminPost(
            config.directorOrigin,
            '/v1/admin/cell-fence-attempt-operation',
            {
              ...fenceAttemptBody(attempt),
              invocationId: invocation.invocationId,
              invocationRequestReason: invocation.requestReason,
              confirmation: 'RECORD_TERRAFORM_CELL_FENCE_OPERATION'
            }
          ),
        assertZeroDiff: async () =>
          assertTerraformFenceZeroDiff(fenceConfig, {
            terraform: deps.terraform
          }),
        postApplyGuard,
        attest,
        emit: deps.emit
      },
      config.completedFenceRecovery
    )
    return
  }
  if (
    existingAttempt &&
    !existingAttempt.abortedAt &&
    !existingAttempt.completedAt &&
    existingAttempt.fenceCommit !== config.fenceCommit
  ) {
    await deps.terraformFenceSupersede(fenceConfig, {
      assertCommittedFenceSet: async () =>
        assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
      loadAttempt: async () => existingAttempt,
      resolvePlan: async (attempt) =>
        await resolveTerraformFencePlanGeneration(
          fenceConfig,
          { commandResult: deps.commandResult },
          attempt
        ),
      inspectProgress,
      abortAttempt: async (attempt) =>
        await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-abort', {
          ...fenceAttemptBody(attempt),
          confirmation: 'ABORT_UNSTARTED_TERRAFORM_CELL_FENCE'
        }),
      emit: deps.emit
    })
    existingAttempt = null
  }
  if (
    existingAttempt &&
    !existingAttempt.abortedAt &&
    (alreadyFenced || !existingAttempt.completedAt)
  ) {
    await deps.terraformFenceResume(fenceConfig, {
      terraform: deps.terraform,
      assertCommittedFenceSet: async () =>
        assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
      loadAttempt: async () => existingAttempt,
      resolvePlan: async (attempt) =>
        await resolveTerraformFencePlanGeneration(
          fenceConfig,
          { commandResult: deps.commandResult },
          attempt
        ),
      bindPlan: async (attempt) =>
        await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-plan', {
          ...fenceAttemptBody(attempt),
          confirmation: 'BIND_TERRAFORM_CELL_FENCE_PLAN'
        }),
      inspectProgress,
      assertZeroDiff: async () =>
        assertTerraformFenceZeroDiff(fenceConfig, { terraform: deps.terraform }),
      assertStateFenced: async () =>
        assertTerraformFenceStateFenced(fenceConfig, { terraform: deps.terraform }),
      preApplyGuard,
      postApplyGuard,
      markOperation: async (attempt, invocation) =>
        await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-operation', {
          ...fenceAttemptBody(attempt),
          invocationId: invocation.invocationId,
          invocationRequestReason: invocation.requestReason,
          confirmation: 'RECORD_TERRAFORM_CELL_FENCE_OPERATION'
        }),
      markApplyStarted: async (attempt, invocation) =>
        await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-start', {
          ...fenceAttemptBody(attempt),
          invocationId: invocation.invocationId,
          invocationRequestReason: invocation.requestReason,
          confirmation: 'START_TERRAFORM_CELL_FENCE'
        }),
      attest,
      ...planStore,
      emit: deps.emit
    })
    return
  }
  if (alreadyFenced) {
    await deps.terraformFenceAdopt(fenceConfig, {
      loadAttempt: async () =>
        (
          await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-status', {
            v: 1,
            cellId: cell.cellId
          })
        ).attempt,
      assertCommittedFenceSet: async () =>
        assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
      assertStateFenced: async () =>
        assertTerraformFenceStateFenced(fenceConfig, { terraform: deps.terraform }),
      preApplyGuard,
      postApplyGuard,
      attest: async (incarnation) =>
        await adminPost(config.directorOrigin, '/v1/admin/cell-fence-adopt-legacy', {
          v: 1,
          cellId: cell.cellId,
          cellIncarnation: incarnation,
          confirmation: 'ADOPT_LEGACY_TERRAFORM_CELL_FENCE'
        }),
      commitAdoption: async (incarnation) =>
        await adminPost(
          config.directorOrigin,
          '/v1/admin/cell-fence-commit-legacy-adoption',
          {
            v: 1,
            cellId: cell.cellId,
            cellIncarnation: incarnation,
            confirmation: 'COMMIT_LEGACY_TERRAFORM_CELL_FENCE_ADOPTION'
          }
        ),
      emit: deps.emit
    })
    return
  }
  if (existingAttempt && !existingAttempt.abortedAt && !existingAttempt.completedAt) {
    throw new Error('prepared Terraform fence attempt must be aborted before replacement')
  }
  await deps.terraformFenceApply(fenceConfig, {
    terraform: deps.terraform,
    assertCommittedFenceSet: async () =>
      assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
    inspectProgress,
    assertZeroDiff: async () =>
      assertTerraformFenceZeroDiff(fenceConfig, { terraform: deps.terraform }),
    preApplyGuard,
    postApplyGuard,
    ...planStore,
    prepareAttempt: async (attempt) =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-prepare', {
        ...fenceAttemptBody(attempt),
        confirmation: 'PREPARE_TERRAFORM_CELL_FENCE'
      }),
    bindPlan: async (attempt) =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-plan', {
        ...fenceAttemptBody(attempt),
        confirmation: 'BIND_TERRAFORM_CELL_FENCE_PLAN'
      }),
    markApplyStarted: async (attempt, invocation) =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-start', {
        ...fenceAttemptBody(attempt),
        invocationId: invocation.invocationId,
        invocationRequestReason: invocation.requestReason,
        confirmation: 'START_TERRAFORM_CELL_FENCE'
      }),
    markOperation: async (attempt, invocation) =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-operation', {
        ...fenceAttemptBody(attempt),
        invocationId: invocation.invocationId,
        invocationRequestReason: invocation.requestReason,
        confirmation: 'RECORD_TERRAFORM_CELL_FENCE_OPERATION'
      }),
    attest,
    emit: deps.emit
  })
}

async function abortTerraformManagedFence(config, deps, adminPost, cell) {
  const result = await adminPost(
    config.directorOrigin,
    '/v1/admin/cell-fence-attempt-status',
    { v: 1, cellId: cell.cellId }
  )
  const attempt = result.attempt
  const fenceConfig = terraformFenceConfig(config, cell, attempt?.cellIncarnation)
  await deps.terraformFenceAbort(fenceConfig, {
    terraform: deps.terraform,
    assertCommittedFenceSet: async () =>
      assertTerraformFenceSet(fenceConfig, { terraform: deps.terraform }),
    loadAttempt: async () => attempt,
    resolvePlan: async (value) =>
      await resolveTerraformFencePlanGeneration(
        fenceConfig,
        { commandResult: deps.commandResult },
        value
      ),
    bindPlan: async (value) =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-plan', {
        ...fenceAttemptBody(value),
        confirmation: 'BIND_TERRAFORM_CELL_FENCE_PLAN'
      }),
    inspectProgress: async () =>
      await inspectTerraformFenceProgress(
        fenceConfig,
        {
          terraform: deps.terraform,
          gcloudJson: deps.commandJson
        },
        attempt
      ),
    abortAttempt: async () =>
      await adminPost(config.directorOrigin, '/v1/admin/cell-fence-attempt-abort', {
        ...fenceAttemptBody(attempt),
        confirmation: 'ABORT_UNSTARTED_TERRAFORM_CELL_FENCE'
      }),
    deletePlan: async (value) =>
      await deleteTerraformFencePlan(
        fenceConfig,
        { commandResult: deps.commandResult },
        value
      ),
    emit: deps.emit
  })
}

async function fenceSource(
  config,
  deps,
  adminPost,
  source,
  targets,
  sourceProcess,
  sourceStatus,
  sourceAlreadyFenced
) {
  if (sourceStatus.enabled) throw new Error('source fencing requires disabled admission')
  const counts = sourceProcess
  if (
    (!sourceAlreadyFenced &&
      (!counts ||
        sourceStatus.runtime?.observedRequests !== 0 ||
        counts.controls !== 0 ||
        counts.splices !== 0 ||
        counts.pendingSplices !== 0)) ||
    sourceStatus.activityLeases !== 0 ||
    sourceStatus.reservedRequests !== 0
  ) {
    throw new Error('source fencing requires zero source-owned work')
  }
  const statuses = await allPairStatuses(config, adminPost, false)
  const totals = statusTotals(statuses)
  if (
    totals.inProgress !== sourceStatus.outgoingMigrations ||
    !hasDurableTargetOwnership(totals)
  ) {
    throw new Error('source fencing requires full migration coverage and durable target ownership')
  }
  for (const target of targets) await targetRuntime(config, adminPost, target)
  const cellIncarnation = runtimeIncarnation(sourceStatus, source.cellId)
  const postApplyGuard = async (expectedIncarnation) => {
    const actualIncarnation = await waitForFence(config, deps, adminPost, source)
    if (actualIncarnation !== expectedIncarnation) {
      throw new Error('fenced source incarnation changed')
    }
    const finalSourceMig = sourceMig(config, deps, source)
    if (finalSourceMig.instances.length !== 0) {
      throw new Error('fenced source still has an instance')
    }
    await inspectFencedSource(config, deps, adminPost, source, finalSourceMig.mig)
  }
  await runTerraformManagedFence(
    config,
    deps,
    adminPost,
    source,
    cellIncarnation,
    sourceAlreadyFenced,
    async () => {
      const latestStatus = sourceAlreadyFenced
        ? await inspectFencedSource(
            config,
            deps,
            adminPost,
            source,
            sourceMig(config, deps, source).mig
          )
        : {
            ...await inspectDirectorObservedCell(config, deps, adminPost, source),
            process: null
          }
      const latestCounts = sourceAlreadyFenced
        ? null
        : processCounts(config, deps, latestStatus, source.cellId)
      if (
        latestStatus.enabled ||
        runtimeIncarnation(latestStatus, source.cellId) !== cellIncarnation ||
        (!sourceAlreadyFenced &&
          (latestStatus.runtime?.observedRequests !== 0 ||
            latestCounts.controls !== 0 ||
            latestCounts.splices !== 0 ||
            latestCounts.pendingSplices !== 0)) ||
        latestStatus.activityLeases !== 0 ||
        latestStatus.reservedRequests !== 0
      ) {
        throw new Error('source fencing guards changed before Terraform apply')
      }
      const latestStatuses = await allPairStatuses(config, adminPost, false)
      const latestTotals = statusTotals(latestStatuses)
      if (
        latestTotals.inProgress !== latestStatus.outgoingMigrations ||
        !hasDurableTargetOwnership(latestTotals)
      ) {
        throw new Error('source migration coverage or guards changed before Terraform apply')
      }
      for (const target of targets) {
        await inspectDirectorObservedCell(config, deps, adminPost, target)
      }
    },
    postApplyGuard
  )
  await waitForMultiStatus(config, deps, adminPost, targets, true, false, true)
  deps.emit({ event: 'source_fenced', sourceCellId: source.cellId, targetSize: 0 })
}

async function runTargetSupersession(
  config,
  deps,
  adminPost,
  source,
  targets,
  selector
) {
  const failed = targets.find((target) => target.cellId === config.failedTargetCellId)
  const replacement = targets.find(
    (target) => target.cellId === config.replacementTargetCellId
  )
  if (!failed || !replacement) throw new Error('supersession topology is incomplete')
  const sourceStatus = await adminPost(config.directorOrigin, '/v1/admin/cell-status', {
    v: 1,
    cellId: source.cellId
  })
  if (
    sourceStatus.status?.cellUrl !== source.origin ||
    (selector
      ? selectorCellState(selector, source.cellId) !== 'existing-only'
      : sourceStatus.status.enabled)
  ) {
    throw new Error('supersession requires retained disabled source topology')
  }
  const failedMig = sourceMig(config, deps, failed)
  const failedStatus = await inspectFenceCandidate(
    config,
    deps,
    adminPost,
    failed,
    failedMig.mig
  )
  if (
    selector
      ? selectorCellState(selector, failed.cellId) !== 'existing-only'
      : failedStatus.enabled
  ) {
    throw new Error(
      selector
        ? 'failed target admission must be existing-only'
        : 'failed target admission must be disabled'
    )
  }
  const replacementStatus = await inspectDirectorObservedCell(
    config,
    deps,
    adminPost,
    replacement
  )
  const migrationStatus = await pairStatus(config, adminPost, failed.cellId, false)
  if (
    !Number.isSafeInteger(migrationStatus.targetRegistered) ||
    migrationStatus.targetRegistered < 1
  ) {
    throw new Error('failed target has no registered migrations to supersede')
  }
  const failedConnections = failedStatus.runtime?.observedRequests
  if (!Number.isSafeInteger(failedConnections) || failedConnections < 0) {
    throw new Error('failed target has no exact runtime connection snapshot')
  }
  const replacementConnections = runtimeConnections(
    replacementStatus.process,
    replacement.cellId
  )
  const projectedConnections =
    replacementConnections +
    Math.max(failedConnections, migrationStatus.targetRegistered)
  if (projectedConnections >= targetConnectionCeiling(config, replacement)) {
    throw new Error('replacement target lacks conservative connection headroom')
  }
  const cellIncarnation = runtimeIncarnation(failedStatus, failed.cellId)
  await runTerraformManagedFence(
    config,
    deps,
    adminPost,
    failed,
    cellIncarnation,
    Number(failedMig.mig.targetSize) === 0,
    async () => {
      const latestMig = sourceMig(config, deps, failed)
      const latestStatus = await inspectFenceCandidate(
        config,
        deps,
        adminPost,
        failed,
        latestMig.mig
      )
      if (
        selector
          ? selectorCellState(selector, failed.cellId) !== 'existing-only'
          : latestStatus.enabled
      ) {
        throw new Error('failed target admission changed before apply')
      }
      if (runtimeIncarnation(latestStatus, failed.cellId) !== cellIncarnation) {
        throw new Error('failed target incarnation changed before apply')
      }
      const latestMigration = await pairStatus(config, adminPost, failed.cellId, false)
      if (latestMigration.targetRegistered < 1) {
        throw new Error('failed target migrations changed before apply')
      }
      await inspectDirectorObservedCell(config, deps, adminPost, replacement)
    },
    async (expectedIncarnation) => {
      const actualIncarnation = await waitForFence(config, deps, adminPost, failed)
      if (actualIncarnation !== expectedIncarnation) {
        throw new Error('failed target incarnation changed')
      }
      const finalFailedMig = sourceMig(config, deps, failed)
      if (finalFailedMig.instances.length !== 0) {
        throw new Error('failed target fence still has an instance')
      }
      await inspectFencedSource(config, deps, adminPost, failed, finalFailedMig.mig)
    }
  )
  if (
    selector &&
    selectorCellState(selector, replacement.cellId) !== 'migration-only'
  ) {
    throw new Error('replacement target admission must be migration-only')
  }
  if (!selector && !replacementStatus.enabled) {
    await setCellState(config, adminPost, replacement.cellId, true)
  }
  let superseded = 0
  while (true) {
    const result = await adminPost(
      config.directorOrigin,
      '/v1/admin/migration-supersede-cell',
      {
        v: 1,
        sourceCellId: source.cellId,
        currentTargetCellId: failed.cellId,
        replacementTargetCellId: replacement.cellId,
        limit: config.batchSize,
        confirmation: 'SUPERSEDE_REGISTERED_CELL_MIGRATIONS'
      }
    )
    if (
      !Number.isSafeInteger(result.superseded) ||
      result.superseded < 0 ||
      result.superseded > config.batchSize
    ) {
      throw new Error('invalid registered supersession result')
    }
    superseded += result.superseded
    if (result.superseded === 0) break
  }
  const remaining = await pairStatus(config, adminPost, failed.cellId, false)
  if (remaining.targetRegistered !== 0) {
    throw new Error('registered target supersession did not reconcile')
  }
  if (superseded !== migrationStatus.targetRegistered) {
    throw new Error('registered target supersession count changed')
  }
  deps.emit({
    event: 'registered_target_superseded',
    sourceCellId: source.cellId,
    failedTargetCellId: failed.cellId,
    replacementTargetCellId: replacement.cellId,
    superseded,
    remainingUnregistered: remaining.inProgress
  })
}

export async function runMultiTargetDeployment(config, overrides = {}) {
  const deps = {
    commandJson: overrides.commandJson ?? defaultCommandJson,
    command: overrides.command ?? defaultCommand,
    commandResult: overrides.commandResult ?? defaultCommandResult,
    terraform: overrides.terraform,
    terraformFenceApply: overrides.terraformFenceApply ?? runTerraformFenceApply,
    terraformFenceAdopt:
      overrides.terraformFenceAdopt ?? adoptLegacyTerraformFence,
    terraformFenceResume: overrides.terraformFenceResume ?? resumeTerraformFence,
    terraformFenceRecoverCompleted:
      overrides.terraformFenceRecoverCompleted ??
      recoverSupersededCompletedTerraformFence,
    terraformFenceAbort: overrides.terraformFenceAbort ?? abortTerraformFenceBeforeApply,
    terraformFenceSupersede:
      overrides.terraformFenceSupersede ?? abortSupersededTerraformFenceBeforeUpload,
    identityToken: overrides.identityToken ?? defaultIdentityToken,
    mutationIdentityToken:
      overrides.mutationIdentityToken ??
      (() => suppliedFenceMutationIdentityToken()),
    fetch: overrides.fetch ?? fetch,
    emit: overrides.emit ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`)),
    now: overrides.now ?? Date.now,
    wait: overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: overrides.random ?? Math.random,
    resolve4: overrides.resolve4 ?? resolve4
  }
  const topology = JSON.parse(readFileSync(config.topologyFile, 'utf8'))
  const { source, targets } = selectMultiTargetDeployments(
    topology,
    config.sourceCellId,
    config.targetCellIds
  )
  const token = deps.identityToken(config.adminAudience)
  const mutationToken =
    ['fence-source', 'abort-fence-source', 'supersede-target'].includes(config.mode)
      ? deps.mutationIdentityToken(config.adminAudience)
      : null
  if (
    ['fence-source', 'abort-fence-source', 'supersede-target'].includes(config.mode) &&
    mutationToken === null
  ) {
    throw new Error('Terraform fence mode requires a broker mutation identity token')
  }
  const adminPost = createAdminPost(
    config,
    deps,
    (path) => (FENCE_BROKER_MUTATION_ROUTES.has(path) ? mutationToken : token)
  )
  if (config.mode === 'abort-fence-source') {
    await abortTerraformManagedFence(config, deps, adminPost, source)
    return
  }
  const selectorPost = async (path, body) =>
    await adminPost(config.directorOrigin, path, body)
  const selectorInspection = await inspectAdmissionSelector(selectorPost)
  const selectorActive = selectorInspection.selector.generation > 0
  if (config.mode === 'cutover-admission') {
    const membership = cutoverMembership(topology, config)
    if (
      selectorActive &&
      JSON.stringify(selectorInspection.selector.membership) !== JSON.stringify(membership)
    ) {
      throw new Error('selector boundary is already active with different membership')
    }
    await inspectCutoverCells(topology, config, deps, adminPost, membership)
    pruneIncompatibleDirectorRevisions(config, deps)
    const director = verifySelectorCompatibleDirector(config, deps)
    await inspectCutoverCells(topology, config, deps, adminPost, membership)
    const result = await applyExactAdmissionSelector(selectorPost, membership, {
      requireBoundary: false,
      attemptId: config.selectorAttemptId,
      expectedCurrentSelector: selectorInspection.selector
    })
    deps.emit({
      event: 'admission_selector_cutover',
      generation: result.selector.generation,
      membership: result.selector.membership,
      ...director
    })
    return
  }
  if (config.mode === 'add-migration-cells') {
    if (!selectorActive) throw new Error('admission selector boundary is not active')
    pruneIncompatibleDirectorRevisions(config, deps)
    const director = verifySelectorCompatibleDirector(config, deps)
    if (
      targets.some(
        (target) =>
          target.connectionHardCap === undefined ||
          target.connectionUnobservedBound === undefined
      )
    ) {
      throw new Error('migration cells require reviewed connection capacity')
    }
    const result = await addExactMigrationCells(
      selectorPost,
      {
        attemptId: config.selectorAttemptId,
        cells: targets.map((target) => ({
          cellId: target.cellId,
          cellUrl: target.origin,
          region: target.region,
          capacityRequests: target.capacityRequests,
          connectionHardCap: target.connectionHardCap,
          connectionUnobservedBound: target.connectionUnobservedBound
        }))
      },
      { expectedCurrentSelector: selectorInspection.selector }
    )
    deps.emit({
      event: 'migration_cells_added',
      generation: result.selector.generation,
      membership: result.selector.membership,
      cellIds: targets.map(({ cellId }) => cellId),
      ...director
    })
    return
  }
  if (config.mode === 'promote-general-cell') {
    if (!selectorActive) throw new Error('admission selector boundary is not active')
    const [promoted] = targets
    if (
      !promoted ||
      selectorCellState(selectorInspection.selector, promoted.cellId) !== 'migration-only'
    ) {
      throw new Error('promoted cell admission must be migration-only')
    }
    const director = verifyActiveSelectorDirector(config, deps, promoted.cellId)
    await inspectGeneralPromotionTarget(config, deps, adminPost, promoted)
    const result = await applyExactAdmissionSelector(
      selectorPost,
      membershipWithStates(selectorInspection.selector, {
        [promoted.cellId]: 'general'
      }),
      {
        attemptId: config.selectorAttemptId,
        expectedCurrentSelector: selectorInspection.selector
      }
    )
    deps.emit({
      event: 'migration_cell_promoted_general',
      generation: result.selector.generation,
      membership: result.selector.membership,
      cellId: promoted.cellId,
      ...director
    })
    return
  }
  if (config.mode === 'retire-migration-cell') {
    if (!selectorActive) throw new Error('admission selector boundary is not active')
    const [retiring] = targets
    if (
      !retiring ||
      selectorCellState(selectorInspection.selector, retiring.cellId) !== 'migration-only'
    ) {
      throw new Error('retired cell admission must be migration-only')
    }
    pruneIncompatibleDirectorRevisions(config, deps)
    const director = verifySelectorCompatibleDirector(config, deps)
    const result = await applyExactAdmissionSelector(
      selectorPost,
      membershipWithStates(selectorInspection.selector, {
        [retiring.cellId]: 'existing-only'
      }),
      {
        attemptId: config.selectorAttemptId,
        expectedCurrentSelector: selectorInspection.selector
      }
    )
    deps.emit({
      event: 'migration_cell_retired',
      generation: result.selector.generation,
      membership: result.selector.membership,
      cellId: retiring.cellId,
      ...director
    })
    return
  }
  if (config.mode === 'supersede-target') {
    await runTargetSupersession(
      config,
      deps,
      adminPost,
      source,
      targets,
      selectorActive ? selectorInspection.selector : null
    )
    return
  }
  const sourceFence = config.mode === 'fence-source' ? sourceMig(config, deps, source) : null
  if (
    sourceFence &&
    ![0, 1].includes(Number(sourceFence.mig.targetSize))
  ) {
    throw new Error('source MIG must be fixed-one or already fenced')
  }
  const fencedResume = sourceFence && Number(sourceFence.mig.targetSize) === 0 ? sourceFence : null
  const { sourceProcess, sourceStatus, plannedTargets, sourceAlreadyFenced } = await preflight(
    config,
    deps,
    adminPost,
    source,
    targets,
    fencedResume,
    selectorActive ? selectorInspection.selector : null
  )
  if (config.mode === 'audit' || config.mode === 'preflight') return
  if (config.mode === 'fence-source') {
    await fenceSource(
      config,
      deps,
      adminPost,
      source,
      targets,
      sourceProcess,
      sourceStatus,
      sourceAlreadyFenced
    )
    return
  }
  if (config.mode === 'recover-forward') {
    const invalidSelectorAdmission =
      selectorActive &&
      (selectorCellState(selectorInspection.selector, source.cellId) !== 'existing-only' ||
        plannedTargets.some(
          (target) =>
            selectorCellState(selectorInspection.selector, target.cellId) !==
            'migration-only'
        ))
    if (
      invalidSelectorAdmission ||
      (!selectorActive &&
        (sourceStatus.enabled || plannedTargets.some((target) => !target.status.enabled)))
    ) {
      throw new Error(
        selectorActive
          ? 'forward recovery requires existing-only source and migration-only targets'
          : 'forward recovery requires disabled source and enabled targets'
      )
    }
    let coveredSourceConnections = runtimeConnections(sourceProcess, source.cellId)
    let recoveryTargets = plannedTargets
    for (let pass = 1; pass <= RECOVERY_CATCH_UP_PASSES; pass++) {
      await publishMigrations(config, deps, adminPost, recoveryTargets)
      if (
        await assertRecoveryPreDrain(
          config,
          deps,
          adminPost,
          source,
          targets,
          selectorPost,
          selectorActive ? selectorInspection.selector : null
        )
      ) {
        break
      }
      if (pass === RECOVERY_CATCH_UP_PASSES) {
        throw new Error('source assignments did not quiesce within bounded recovery catch-up')
      }
      const catchUp = await preflight(
        config,
        deps,
        adminPost,
        source,
        targets,
        null,
        selectorActive ? selectorInspection.selector : null,
        coveredSourceConnections
      )
      coveredSourceConnections = Math.max(
        coveredSourceConnections,
        runtimeConnections(catchUp.sourceProcess, source.cellId)
      )
      recoveryTargets = catchUp.plannedTargets
    }
    if (!sourceStatus.draining) {
      const activeSourceTransports =
        sourceProcess.controls + sourceProcess.splices + sourceProcess.pendingSplices
      if (activeSourceTransports > 0) {
        const recovery = await adminPost(
          config.directorOrigin,
          '/v1/admin/drain-attempt-recover-forward',
          {
            v: 1,
            cellId: source.cellId,
            cellIncarnation: runtimeIncarnation(sourceStatus, source.cellId),
            confirmation: 'RECOVER_LEGACY_DRAIN'
          }
        )
        await waitForRecoveryTargetOwnership(config, deps, adminPost, targets)
        if (recovery.preparedAttempt) {
          const attempt = recovery.preparedAttempt
          if (
            attempt.state !== 'prepared' ||
            attempt.cellId !== source.cellId ||
            attempt.cellIncarnation !== runtimeIncarnation(sourceStatus, source.cellId) ||
            attempt.plannedGraceMs !== 120_000 ||
            typeof attempt.attemptId !== 'string' ||
            typeof attempt.traceValue !== 'string'
          ) {
            throw new Error('prepared drain recovery state is invalid')
          }
          const sending = await adminPost(
            config.directorOrigin,
            '/v1/admin/drain-attempt-send',
            {
              v: 1,
              attemptId: attempt.attemptId,
              cellId: source.cellId,
              cellIncarnation: attempt.cellIncarnation
            }
          )
          if (
            sending.attempt?.state !== 'send-may-have-started' ||
            sending.attempt.shouldSend !== true ||
            !Number.isSafeInteger(sending.attempt.sendPermitExpiresAt) ||
            deps.now() >= sending.attempt.sendPermitExpiresAt
          ) {
            throw new Error('prepared drain recovery send permit unavailable')
          }
          const receipt = await drainSource(
            config,
            deps,
            token,
            source,
            attempt.plannedGraceMs,
            attempt.traceValue
          )
          await adminPost(config.directorOrigin, '/v1/admin/drain-attempt-receipt', {
            v: 1,
            attemptId: attempt.attemptId,
            cellId: source.cellId,
            cellIncarnation: attempt.cellIncarnation,
            traceValue: attempt.traceValue,
            ...receipt
          })
          deps.emit({
            event: 'source_prepared_drain_recovered',
            sourceCellId: source.cellId
          })
        } else if (recovery.shouldSend === true) {
          await drainSource(config, deps, token, source, 0)
          deps.emit({ event: 'source_recovery_drain_accepted', sourceCellId: source.cellId })
        } else {
          const latestSource = await inspectCell(config, deps, adminPost, source)
          const expectedIncarnation = runtimeIncarnation(sourceStatus, source.cellId)
          if (runtimeIncarnation(latestSource, source.cellId) !== expectedIncarnation) {
            throw new Error('source incarnation changed before recovery drain reissue')
          }
          if (latestSource.draining) {
            deps.emit({
              event: 'source_recovery_drain_already_applied',
              sourceCellId: source.cellId
            })
          } else {
            const latestStatuses = await allPairStatuses(config, adminPost, false)
            const latestTotals = statusTotals(latestStatuses)
            assertLeaseGate(latestStatuses, config.minimumLeaseRemainingMs)
            if (
              !hasDurableTargetOwnership(latestTotals) &&
              !boundedUnregisteredMigrations(
                latestTotals,
                config.unobservedConnectionBound
              )
            ) {
              throw new Error('recovery target ownership changed before drain reissue')
            }
            await drainSource(config, deps, token, source, 0)
            deps.emit({
              event: 'source_recovery_drain_reissued_after_non_delivery',
              sourceCellId: source.cellId,
              ...latestTotals
            })
          }
        }
      } else {
        deps.emit({
          event: 'source_recovery_drain_not_needed',
          sourceCellId: source.cellId
        })
      }
    }
    await waitForMultiStatus(config, deps, adminPost, targets, false, true)
    await waitForRecoveredSourceZero(
      config,
      deps,
      adminPost,
      source,
      runtimeIncarnation(sourceStatus, source.cellId)
    )
    await waitForMultiStatus(config, deps, adminPost, targets, true, true)
    deps.emit({ event: 'multi_target_complete', sourceCellId: source.cellId })
    return
  }
  if (
    selectorActive &&
    targets.some(
      (target) =>
        selectorCellState(selectorInspection.selector, target.cellId) !== 'migration-only'
    )
  ) {
    throw new Error('evacuation targets must be migration-only')
  }
  await runEvacuation(
    config,
    deps,
    adminPost,
    token,
    source,
    targets,
    plannedTargets,
    sourceStatus,
    selectorActive,
    selectorPost,
    selectorInspection.selector
  )
}

export async function main(argv = process.argv.slice(2)) {
  await runMultiTargetDeployment(parseMultiTargetArguments(argv))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
