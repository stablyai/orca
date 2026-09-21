import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  allocateTargetQuotas,
  assertCutoverCellReady,
  cutoverMembership,
  parseMultiTargetArguments,
  pruneIncompatibleDirectorRevisions,
  runMultiTargetDeployment,
  sameBackendServiceResource,
  selectMultiTargetDeployments,
  verifySelectorCompatibleDirector
} from './deploy-relay-gce-multi-target.mjs'

const runtimeServiceAccount = 'orca-relay@example.iam.gserviceaccount.com'
const digest = (value) => `sha256:${value.repeat(64)}`

test('matches only exact canonical backend-service resource forms', () => {
  const resource = 'projects/onorca-cloud/global/backendServices/orca-cloud-relay-gce-c11'
  assert.equal(
    sameBackendServiceResource(
      `https://www.googleapis.com/compute/v1/${resource}`,
      resource
    ),
    true
  )
  assert.equal(
    sameBackendServiceResource(
      `https://www.googleapis.com/compute/v1/${resource}`,
      resource.replace('c11', 'c12')
    ),
    false
  )
  assert.equal(
    sameBackendServiceResource(
      `https://compute.example/compute/v1/${resource}`,
      resource
    ),
    false
  )
})

test('requires only compatible active and rollback director revisions', () => {
  let rollbackInventory = ['c1']
  const revision = (minimum = 1, inventory = ['c1']) => ({
    metadata: {
      annotations: { 'autoscaling.knative.dev/minScale': String(minimum) }
    },
    spec: {
      containers: [
        {
          image: 'registry.example/relay@sha256:abc',
          env: [
            { name: 'ORCA_RELAY_ROLE', value: 'director' },
            { name: 'ORCA_RELAY_ADMISSION_SELECTOR_VERSION', value: '3' },
            {
              name: 'ORCA_RELAY_CELLS_JSON',
              value: JSON.stringify(inventory.map((id) => ({ id })))
            }
          ]
        }
      ]
    }
  })
  let names = ['active', 'rollback']
  const deps = {
    command: (args) => {
      const revision = args[3]
      names = names.filter((name) => name !== revision)
    },
    commandJson: (args) => {
      if (args.includes('services')) {
        return {
          status: {
            traffic: [
              { percent: 100, revisionName: 'active' },
              { tag: 'selector-rollback', revisionName: 'rollback' }
            ]
          }
        }
      }
      if (args.includes('list')) {
        return names.map((name) => ({ metadata: { name } }))
      }
      return args.includes('rollback')
        ? revision(0, rollbackInventory)
        : revision(1)
    }
  }
  const config = {
    project: 'project',
    directorRegion: 'region',
    directorService: 'service',
    directorMinimumInstances: 1
  }
  assert.deepEqual(verifySelectorCompatibleDirector(config, deps), {
    activeRevision: 'active',
    rollbackRevision: 'rollback'
  })
  rollbackInventory = ['c1', 'c2']
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /director inventories do not match/
  )
  assert.throws(
    () => pruneIncompatibleDirectorRevisions(config, deps),
    /director compatibility pair failed/
  )
  rollbackInventory = ['c1']
  names = ['active', 'rollback', 'legacy']
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /old or pre-selector director revisions/
  )
  pruneIncompatibleDirectorRevisions(config, deps)
  assert.deepEqual(names, ['active', 'rollback'])
  assert.deepEqual(verifySelectorCompatibleDirector(config, deps), {
    activeRevision: 'active',
    rollbackRevision: 'rollback'
  })
  names = ['active', 'rollback', null]
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /old or pre-selector director revisions/
  )
  assert.throws(
    () => pruneIncompatibleDirectorRevisions(config, deps),
    /unnamed revision/
  )
})

test('requires the active director to meet the configured floor', () => {
  let activeMinimum = 5
  let rollbackMinimum = 0
  const revision = (minimum) => ({
    metadata: {
      annotations: { 'autoscaling.knative.dev/minScale': String(minimum) }
    },
    spec: {
      containers: [
        {
          image: 'registry.example/relay@sha256:abc',
          env: [
            { name: 'ORCA_RELAY_ROLE', value: 'director' },
            { name: 'ORCA_RELAY_ADMISSION_SELECTOR_VERSION', value: '3' },
            {
              name: 'ORCA_RELAY_CELLS_JSON',
              value: JSON.stringify([{ id: 'c1' }])
            }
          ]
        }
      ]
    }
  })
  const deps = {
    command: () => {},
    commandJson: (args) => {
      if (args.includes('services')) {
        return {
          status: {
            traffic: [
              { percent: 100, revisionName: 'active' },
              { tag: 'selector-rollback', revisionName: 'rollback' }
            ]
          }
        }
      }
      if (args.includes('list')) {
        return ['active', 'rollback'].map((name) => ({ metadata: { name } }))
      }
      return args.includes('rollback') ? revision(rollbackMinimum) : revision(activeMinimum)
    }
  }
  const config = {
    project: 'project',
    directorRegion: 'region',
    directorService: 'service',
    directorMinimumInstances: 5
  }

  assert.deepEqual(verifySelectorCompatibleDirector(config, deps), {
    activeRevision: 'active',
    rollbackRevision: 'rollback'
  })
  pruneIncompatibleDirectorRevisions(config, deps)

  activeMinimum = 4
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /active selector revision is below the required floor/
  )
  assert.throws(
    () => pruneIncompatibleDirectorRevisions(config, deps),
    /director compatibility pair failed/
  )

  // Every comparison against NaN is false, so negating the minimum check rejects it.
  activeMinimum = 'warm'
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /active selector revision is below the required floor/
  )
  assert.throws(
    () => pruneIncompatibleDirectorRevisions(config, deps),
    /director compatibility pair failed/
  )

  activeMinimum = 5
  rollbackMinimum = 1
  assert.throws(
    () => verifySelectorCompatibleDirector(config, deps),
    /selector rollback revision is not scale-to-zero/
  )
  assert.throws(
    () => pruneIncompatibleDirectorRevisions(config, deps),
    /director compatibility pair failed/
  )
})

function topology() {
  const cell = (id, hostname, initiallyEnabled) => ({
    origin: `https://${hostname}.relay.example.com`,
    zone: `us-central1-${hostname}`,
    mig_name: `relay-${hostname}`,
    instance_group: `https://compute.example/instanceGroups/relay-${hostname}`,
    backend_name: `relay-${hostname}`,
    backend_id: `https://compute.example/backendServices/relay-${hostname}`,
    url_map_name: 'orca-relay',
    generation_identity: `https://compute.example/instanceTemplates/relay-${hostname}-abc`,
    image: `us-central1-docker.pkg.dev/project/repo/relay@${digest(id)}`,
    capacity_requests: 4_000,
    connection_hard_cap: 600,
    connection_unobserved_bound: 40,
    initially_enabled: initiallyEnabled,
    fenced: false,
    desired_target_size: 1,
    target_size: 1
  })
  return {
    source: cell('a', 'a', true),
    target1: cell('b', 'b', false),
    target2: cell('c', 'c', false),
    general: cell('d', 'd', true)
  }
}

function withTopology(operation, value = topology()) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-gce-multi-'))
  const file = join(directory, 'topology.json')
  writeFileSync(file, JSON.stringify(value))
  return Promise.resolve(operation(file)).finally(() => rmSync(directory, { recursive: true }))
}

function config(topologyFile, mode = 'preflight') {
  const selectorMutation = [
    'cutover-admission',
    'add-migration-cells',
    'promote-general-cell',
    'retire-migration-cell'
  ].includes(mode)
  return {
    project: 'test-project',
    directorOrigin: 'https://relay.example.com',
    adminAudience: 'https://relay.example.com/v1/admin/drain',
    topologyFile,
    sourceCellId: 'source',
    targetCellIds: ['promote-general-cell', 'retire-migration-cell'].includes(mode)
      ? ['target1']
      : ['target1', 'target2'],
    generalCellIds: mode === 'cutover-admission' ? ['general'] : [],
    directorRegion: selectorMutation ? 'us-central1' : undefined,
    directorService: selectorMutation ? 'relay-director' : undefined,
    directorMinimumInstances: selectorMutation ? 1 : undefined,
    selectorAttemptId:
      mode === 'add-migration-cells'
        ? 'add_cells_test'
        : mode === 'promote-general-cell'
          ? 'promote_cell_test'
        : mode === 'retire-migration-cell'
          ? 'retire_cell_test'
          : undefined,
    unobservedConnectionBound:
      selectorMutation || mode === 'fence-source' ? 40 : undefined,
    failedTargetCellId: mode === 'supersede-target' ? 'target1' : undefined,
    replacementTargetCellId: mode === 'supersede-target' ? 'target2' : undefined,
    runtimeServiceAccount,
    environment: 'production',
    fenceCommit: 'a'.repeat(40),
    terraformDir: 'infra/terraform',
    terraformVarFile: 'environments/production.tfvars',
    mode,
    batchSize: 2,
    connectionCeiling: mode === 'fence-source' ? 600 : 6,
    minimumLeaseRemainingMs: 600_000,
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

function harness({
  leaseRemainingMs = 900_000,
  refreshedLeaseRemainingMs = leaseRemainingMs,
  failAfterDrain = false,
  failEvacuationStatus = false,
  fence = false,
  allowPreFenceCompletion = false,
  loseResizeResponse = false,
  resumeNeedsPreApply = false,
  loseDrainSendResponse = false,
  loseDrainBeforeAccept = false,
  preparedDrainAttempt = false,
  recoverableDrain = false,
  recoveryAlreadyAttempted = false,
  preexistingRegisteredMigrations = 0,
  supersede = false,
  cleanupBeforeSupersession = false,
  offlineTargetMigrations = 0,
  offlineTargetMigrationsByTarget = {},
  unregisteredTargetMigrations = 0,
  registeredSourceActive = 0,
  recoveryRegistrationDelayReads = 0,
  failedTargetEnabled = false,
  replacementHeartbeatFresh = true,
  replacementRuntimeCellUrl,
  legacySource = false,
  legacyMetricAgeMs = 0,
  selectorMembership = null,
  capacitySourceAssignments = [],
  capacityRequiredTargetUnits = [],
  headroomFailureTarget = null,
  sourceAssignments = fence ? 0 : 4,
  sourceRequiredTargetUnits = fence ? 0 : 8,
  sourceObservedRequests = null,
  sourceOutgoingMigrations = null,
  existingFenceAttempt = false,
  alreadyFencedSource = false,
  supersededFenceAttempt = false,
  completedFenceAttempt = false,
  activeDirectorMinimum = 1,
  misroutedCell = null,
  routeOverrideCell = null,
  frontendMisbound = false,
  templateHardCap = 600,
  templateUnobservedBound = 40,
  directorHardCap = templateHardCap,
  directorUnobservedBound = templateUnobservedBound,
  directorCapacityOverrides = {},
  liveMigTemplateOverrides = {},
  topologyValue = topology()
} = {}) {
  const directorCapacity = (cellId) => {
    const hardCap = directorCapacityOverrides[cellId]?.hardCap ?? directorHardCap
    const unobservedBound =
      directorCapacityOverrides[cellId]?.unobservedBound ?? directorUnobservedBound
    return {
      hardCap,
      controlRebindReserve: 100,
      ordinaryConnectionLimit: hardCap - 100,
      unobservedBound,
      normalAdmissionPause: hardCap - 100 - unobservedBound
    }
  }
  const cells = {
    source: {
      enabled: !fence && !supersede,
      assignments: 4,
      activityLeases: fence ? 0 : 4,
      totalConnections: fence ? 1 : 5,
      controls: fence ? 0 : 4,
      observedRequests: sourceObservedRequests ?? (fence ? 0 : 4),
      heartbeatFresh: !alreadyFencedSource,
      draining: fence
    },
    target1: {
      enabled: failedTargetEnabled || (fence && !supersede),
      assignments: fence ? 2 : 0,
      activityLeases: fence ? 2 : 0,
      totalConnections: fence ? 2 : 0,
      controls: fence ? 2 : 0,
      heartbeatFresh: !supersede,
      draining: false
    },
    target2: {
      enabled: fence && !supersede,
      assignments: fence ? 2 : 0,
      activityLeases: fence ? 2 : 0,
      totalConnections: fence ? 2 : 0,
      controls: fence ? 2 : 0,
      heartbeatFresh: replacementHeartbeatFresh,
      draining: false
    },
    general: {
      enabled: true,
      assignments: 0,
      activityLeases: 0,
      totalConnections: 0,
      controls: 0,
      heartbeatFresh: true,
      draining: false
    }
  }
  for (const cellId of Object.keys(topologyValue)) {
    cells[cellId] ??= {
      enabled: fence && !supersede,
      assignments: fence ? 2 : 0,
      activityLeases: fence ? 2 : 0,
      totalConnections: fence ? 2 : 0,
      controls: fence ? 2 : 0,
      heartbeatFresh: true,
      draining: false
    }
  }
  const events = []
  const stateChanges = []
  const batches = []
  const publishedMigrations = new Map()
  const runtimeInspections = new Map()
  let drained = fence
  let remainingSourceAssignments = sourceAssignments
  let remainingRequiredTargetUnits = sourceRequiredTargetUnits
  const migSizes = Object.fromEntries(
    Object.keys(topologyValue).map((cellId) => [
      cellId,
      cellId === 'source' && alreadyFencedSource
        ? 0
        : cellId === 'target1' && completedFenceAttempt
          ? 0
          : 1
    ])
  )
  const instanceCounts = { ...migSizes }
  let supersessionRemaining = supersede ? 2 : 0
  let remainingOfflineTargetMigrations = offlineTargetMigrations
  const initialOfflineTargetMigrationsByTarget = new Map(
    Object.entries(offlineTargetMigrationsByTarget)
  )
  const remainingOfflineTargetMigrationsByTarget = new Map(
    initialOfflineTargetMigrationsByTarget
  )
  const targetMigrationTotal = (cellId) =>
    initialOfflineTargetMigrationsByTarget.has(cellId)
      ? initialOfflineTargetMigrationsByTarget.get(cellId)
      : 2
  const remainingOfflineTargetMigrationCount = (cellId) =>
    remainingOfflineTargetMigrationsByTarget.has(cellId)
      ? remainingOfflineTargetMigrationsByTarget.get(cellId)
      : remainingOfflineTargetMigrations
  const clearOfflineTargetMigrations = (cellId) => {
    if (remainingOfflineTargetMigrationsByTarget.has(cellId)) {
      remainingOfflineTargetMigrationsByTarget.set(cellId, 0)
      return
    }
    remainingOfflineTargetMigrations = 0
  }
  let drainReceiptRecorded = recoverableDrain
  let drainSendStarted = false
  let recoveryDrainPrepared = recoveryAlreadyAttempted
  let recoveryLeasesRefreshed = false
  const recoveryRegistrationReads = new Map()
  let headroomFailureInjected = false
  let currentLeaseRemainingMs = leaseRemainingMs
  const drainGraces = []
  const timeline = []
  let fencedCompletions = 0
  let resizeAttempts = 0
  let capacityReads = 0
  let addedCells = []
  let fenceAttested = false
  let fenceAttempt = existingFenceAttempt || supersededFenceAttempt || completedFenceAttempt
    ? {
        attemptId: '44444444-4444-4444-8444-444444444444',
        environment: 'production',
        cellId: 'source',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        migName: topologyValue.source.mig_name,
        instanceGroup: topologyValue.source.instance_group,
        generationIdentity: topologyValue.source.generation_identity,
        fenceCommit: (supersededFenceAttempt || completedFenceAttempt ? 'b' : 'a').repeat(40),
        planSha256: 'd'.repeat(64),
        planObjectName:
          'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
        ...(supersededFenceAttempt && !completedFenceAttempt
          ? {}
          : { planObjectGeneration: '123456789' }),
        varFileSha256: 'e'.repeat(64),
        terraformStateLineage: '55555555-5555-4555-8555-555555555555',
        terraformStateSerial: 7,
        terraformStateObjectGeneration: '987654321',
        terraformStateObjectSha256: 'f'.repeat(64),
        requestReason:
          'orca-relay-fence/44444444-4444-4444-8444-444444444444',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        ...(completedFenceAttempt
          ? {
              applyStartedAt: 101,
              applyInvocations: [
                {
                  invocationId: '66666666-6666-4666-8666-666666666666',
                  requestReason:
                    'orca-relay-fence/44444444-4444-4444-8444-444444444444/66666666-6666-4666-8666-666666666666',
                  startedAt: 101
                }
              ]
            }
          : {})
      }
    : null
  let selector = selectorMembership
    ? { generation: 1, attemptId: 'existing-selector', membership: selectorMembership }
    : null
  const selectorIntents = new Map()
  const cellForOrigin = (origin) => {
    const entry = Object.entries(topologyValue).find(([, value]) => value.origin === origin)
    return entry?.[0]
  }
  const cellForMig = (name) => {
    const entry = Object.entries(topologyValue).find(([, value]) => value.mig_name === name)
    return entry?.[0]
  }
  const commandJson = (args) => {
    if (args[0] === 'run') {
      if (args.includes('services')) {
        return {
          status: {
            traffic: [
              { percent: 100, revisionName: 'active' },
              { percent: 0, tag: 'selector-rollback', revisionName: 'rollback' }
            ]
          }
        }
      }
      if (args.includes('list')) {
        return ['active', 'rollback'].map((name) => ({ metadata: { name } }))
      }
      const revisionName = args[3]
      return {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale':
              revisionName === 'rollback' ? '0' : String(activeDirectorMinimum)
          }
        },
        spec: {
          containers: [
            {
              image: 'registry.example/relay@sha256:abc',
              env: [
                { name: 'ORCA_RELAY_ROLE', value: 'director' },
                { name: 'ORCA_RELAY_ADMISSION_SELECTOR_VERSION', value: '3' },
                {
                  name: 'ORCA_RELAY_CELLS_JSON',
                  value: JSON.stringify(
                    Object.keys(topologyValue).map((id) => ({ id }))
                  )
                }
              ]
            }
          ]
        }
      }
    }
    if (args.includes('instance-templates')) {
      const templateName = args[args.indexOf('describe') + 1]
      const expected = Object.values(topologyValue).find((cell) =>
        cell.generation_identity.endsWith(`/instanceTemplates/${templateName}`)
      )
      return {
        selfLink: expected.generation_identity,
        properties: {
          metadata: {
            items: [
              {
                key: 'startup-script',
                value: [
                  `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${expected.image.split('@')[1]}'`,
                  `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${templateHardCap}'`,
                  `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '${templateUnobservedBound}'`,
                  `docker pull '${expected.image}'`,
                  `docker run '${expected.image}'`
                ].join('\n')
              }
            ]
          }
        }
      }
    }
    if (args[0] === 'logging') {
      return [
        {
          timestamp: new Date(Date.now() - legacyMetricAgeMs).toISOString(),
          jsonPayload: {
            totalConnections: cells.source.totalConnections,
            preAuthConnections: 0,
            controls: cells.source.controls,
            splices: 0,
            pendingSplices: 0,
            queuedBytes: 0
          }
        }
      ]
    }
    const describeIndex = args.indexOf('describe')
    const listIndex = args.indexOf('list-instances')
    const name = args[describeIndex >= 0 ? describeIndex + 1 : listIndex + 1]
    const migCell = cellForMig(name)
    if (args.includes('list-instances')) {
      return instanceCounts[migCell] === 0
        ? []
        : [
            {
              instance: `https://compute.example/instances/${name}-vm`,
              instanceStatus: 'RUNNING',
              currentAction: 'NONE',
              version: {
                name: 'primary',
                instanceTemplate: topologyValue[migCell].generation_identity
              }
            }
          ]
    }
    if (args.includes('instance-groups')) {
      return {
        targetSize: migSizes[migCell],
        instanceTemplate:
          liveMigTemplateOverrides[migCell] ?? topologyValue[migCell].generation_identity,
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
    if (args.includes('target-https-proxies')) {
      return {
        name: 'orca-relay',
        selfLink:
          'https://www.googleapis.com/compute/v1/projects/test-project/global/targetHttpsProxies/orca-relay',
        urlMap: frontendMisbound
          ? 'https://www.googleapis.com/compute/v1/projects/test-project/global/urlMaps/other'
          : 'https://www.googleapis.com/compute/v1/projects/test-project/global/urlMaps/orca-relay'
      }
    }
    if (args.includes('forwarding-rules')) {
      return {
        name: 'orca-relay',
        target:
          'https://www.googleapis.com/compute/v1/projects/test-project/global/targetHttpsProxies/orca-relay',
        IPAddress: '203.0.113.10',
        portRange: '443-443',
        loadBalancingScheme: 'EXTERNAL_MANAGED'
      }
    }
    if (args.includes('addresses')) {
      return { name: 'orca-relay', address: '203.0.113.10' }
    }
    if (args.includes('url-maps')) {
      return {
        name: 'orca-relay',
        selfLink:
          'https://www.googleapis.com/compute/v1/projects/test-project/global/urlMaps/orca-relay',
        hostRules: Object.entries(topologyValue).map(([cellId, cell]) => ({
          hosts: [new URL(cell.origin).hostname],
          pathMatcher: cellId
        })),
        pathMatchers: Object.entries(topologyValue).map(([cellId, cell]) => ({
          name: cellId,
          defaultService:
            cellId === misroutedCell ? topologyValue.general.backend_id : cell.backend_id,
          ...(cellId === routeOverrideCell
            ? {
                pathRules: [
                  { paths: ['/v1/*'], service: topologyValue.general.backend_id }
                ]
              }
            : {})
        }))
      }
    }
    const id = Object.entries(topologyValue).find(([, value]) => value.backend_name === name)?.[0]
    return {
      protocol: 'HTTP',
      timeoutSec: 86_400,
      backends: [{ group: topologyValue[id].instance_group }]
    }
  }
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/health' || parsed.pathname === '/ready') return response({ ok: true })
    const body = JSON.parse(options.body ?? '{}')
    if (parsed.pathname === '/v1/admin/runtime-status') {
      const id = cellForOrigin(parsed.origin)
      const cell = cells[id]
      const capacity = directorCapacity(id)
      runtimeInspections.set(id, (runtimeInspections.get(id) ?? 0) + 1)
      return response({
        v: 1,
        role: 'cell',
        cellId: id,
        cellUrl: topologyValue[id].origin,
        imageDigest: topologyValue[id].image.split('@')[1],
        draining: cell.draining,
        connectionCapacity: {
          ...capacity
        },
        runtime:
          legacySource && id === 'source'
            ? null
            : {
                totalConnections: cell.totalConnections,
                preAuthConnections: 0,
                enforcedConnectionUnits: cell.totalConnections,
                controls: cell.controls,
                splices: 0,
                pendingSplices: 0,
                queuedBytes: 0
              }
      })
    }
    if (parsed.pathname === '/v1/admin/cell-status') {
      const cell = cells[body.cellId]
      const capacity = directorCapacity(body.cellId)
      return response({
        v: 1,
        status: {
          cellId: body.cellId,
          cellUrl: topologyValue[body.cellId].origin,
          enabled: cell.enabled,
          assignments: cell.assignments,
          activityLeases: cell.activityLeases,
          activityRequestUnits: cell.activityLeases,
          reservedRequests: cell.activityLeases,
          connectionCapacity: {
            ...capacity,
            observedConnections: cell.totalConnections,
            inFlightConnections: 0,
            reservedConnectionUnits: 0,
            enforcedConnectionUnits: cell.totalConnections,
            pendingControlReservations: 0,
            heartbeatFresh: cell.heartbeatFresh
          },
          outgoingMigrations:
            sourceOutgoingMigrations ??
            (fence
              ? Object.keys(topologyValue)
                  .filter((cellId) => cellId !== 'source' && cellId !== 'general')
                  .reduce((total, cellId) => total + targetMigrationTotal(cellId), 0)
              : 0),
          incomingMigrations: 0,
          runtime: {
            cellUrl:
              body.cellId === 'target2' && replacementRuntimeCellUrl
                ? replacementRuntimeCellUrl
                : topologyValue[body.cellId].origin,
            cellIncarnation: '11111111-1111-4111-8111-111111111111',
            ready: true,
            heartbeatFresh: cell.heartbeatFresh,
            observedRequests: cell.observedRequests ?? cell.controls
          }
        }
      })
    }
    if (parsed.pathname === '/v1/admin/admission-selector/status') {
      selector ??= {
        generation: 0,
        attemptId: null,
        membership: {
          existingOnly: Object.keys(cells).filter((cellId) => !cells[cellId].enabled),
          migrationOnly: [],
          general: Object.keys(cells).filter((cellId) => cells[cellId].enabled)
        }
      }
      return response({
        v: 1,
        selector,
        intent: body.attemptId ? selectorIntents.get(body.attemptId) ?? null : null
      })
    }
    if (parsed.pathname === '/v1/admin/admission-selector/apply') {
      selector = {
        generation: body.expectedGeneration + 1,
        attemptId: body.attemptId,
        membership: body.membership
      }
      selectorIntents.set(body.attemptId, {
        attemptId: body.attemptId,
        expectedGeneration: body.expectedGeneration,
        intendedGeneration: selector.generation,
        membership: body.membership,
        state: 'committed'
      })
      return response({ v: 1, changed: true, selector })
    }
    if (parsed.pathname === '/v1/admin/admission-selector/add-migration-cells') {
      addedCells = body.cells
      selector = {
        generation: body.expectedGeneration + 1,
        attemptId: body.attemptId,
        membership: {
          ...selector.membership,
          migrationOnly: [
            ...selector.membership.migrationOnly,
            ...body.cells.map(({ cellId }) => cellId)
          ].sort()
        }
      }
      selectorIntents.set(body.attemptId, {
        attemptId: body.attemptId,
        expectedGeneration: body.expectedGeneration,
        intendedGeneration: selector.generation,
        membership: selector.membership,
        state: 'committed'
      })
      return response({ v: 1, changed: true, selector })
    }
    if (parsed.pathname === '/v1/admin/evacuation-capacity') {
      const read = capacityReads++
      return response({
        v: 1,
        sourceAssignments: capacitySourceAssignments[read] ?? remainingSourceAssignments,
        requiredTargetUnits:
          capacityRequiredTargetUnits[read] ?? remainingRequiredTargetUnits,
        availableTargetUnits: 4_000
      })
    }
    if (parsed.pathname === '/v1/admin/cell-state') {
      cells[body.cellId].enabled = body.enabled
      stateChanges.push([body.cellId, body.enabled])
      return response({ ok: true })
    }
    if (parsed.pathname === '/v1/admin/drain-attempt-prepare') {
      return response({ v: 1, state: 'prepared' })
    }
    if (parsed.pathname === '/v1/admin/drain-attempt-send') {
      const shouldSend = !drainSendStarted
      drainSendStarted = true
      if (loseDrainSendResponse) throw new Error('injected_send_transition_response_loss')
      return response({
        v: 1,
        attempt: {
          state: 'send-may-have-started',
          shouldSend,
          sendPermitExpiresAt: Date.now() + 30_000
        }
      })
    }
    if (parsed.pathname === '/v1/admin/drain-attempt-receipt') {
      drainReceiptRecorded = true
      return response({ v: 1, attempt: { state: 'application-receipt' } })
    }
    if (parsed.pathname === '/v1/admin/drain-attempt-recover-forward') {
      recoveryLeasesRefreshed = true
      currentLeaseRemainingMs = refreshedLeaseRemainingMs
      if (!drainReceiptRecorded) {
        if (preparedDrainAttempt && !drainSendStarted) {
          return response({
            v: 1,
            shouldSend: false,
            retryAfter: Date.now(),
            preparedAttempt: {
              attemptId: '33333333-3333-4333-8333-333333333333',
              cellId: 'source',
              cellIncarnation: '11111111-1111-4111-8111-111111111111',
              traceValue: '44444444-4444-4444-8444-444444444444',
              plannedGraceMs: 120_000,
              state: 'prepared'
            }
          })
        }
        return response({ error: 'drain_application_receipt_missing' }, 409)
      }
      const shouldSend = !recoveryDrainPrepared
      recoveryDrainPrepared = true
      return response({ v: 1, shouldSend, retryAfter: Date.now() })
    }
    if (parsed.pathname === '/v1/admin/evacuate-cell') {
      if (body.targetCellId === headroomFailureTarget && !headroomFailureInjected) {
        headroomFailureInjected = true
        const partiallyStarted = Math.min(1, remainingSourceAssignments)
        publishedMigrations.set(
          body.targetCellId,
          (publishedMigrations.get(body.targetCellId) ?? 0) + partiallyStarted
        )
        remainingSourceAssignments -= partiallyStarted
        return response({ error: 'relay_connection_headroom_exhausted' }, 409)
      }
      const started = Math.min(body.limit, remainingSourceAssignments)
      batches.push([body.targetCellId, started])
      publishedMigrations.set(
        body.targetCellId,
        (publishedMigrations.get(body.targetCellId) ?? 0) + started
      )
      remainingSourceAssignments -= started
      if (remainingSourceAssignments === 0) remainingRequiredTargetUnits = 0
      return response({ v: 1, started })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attest') {
      fenceAttested = true
      return response({ v: 1, cellId: body.cellId, expiresAt: Date.now() + 300_000 })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-adopt-legacy') {
      fenceAttested = true
      return response({ v: 1, cellId: body.cellId, expiresAt: Date.now() + 300_000 })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-commit-legacy-adoption') {
      return response({ v: 1, cellId: body.cellId, committed: true })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attempt-prepare') {
      fenceAttempt = body
      return response({ v: 1, attempt: body })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attempt-start') {
      fenceAttempt = { ...body, applyStartedAt: Date.now() }
      return response({
        v: 1,
        attempt: fenceAttempt,
        invocation: {
          invocationId: body.invocationId,
          requestReason: body.invocationRequestReason,
          startedAt: fenceAttempt.applyStartedAt
        }
      })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attempt-operation') {
      fenceAttempt = body
      return response({
        v: 1,
        attempt: body,
        invocation: {
          invocationId: body.invocationId,
          requestReason: body.invocationRequestReason,
          startedAt: Date.now(),
          gceOperation: body.gceOperation
        }
      })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attempt-status') {
      return response({ v: 1, attempt: fenceAttempt })
    }
    if (parsed.pathname === '/v1/admin/cell-fence-attempt-abort') {
      fenceAttempt = { ...body, abortedAt: Date.now() }
      return response({ v: 1, attempt: fenceAttempt })
    }
    if (parsed.pathname === '/v1/admin/evacuation-status') {
      if (failEvacuationStatus) {
        return response({ error: 'injected_status_failure' }, 500)
      }
      const completed =
        body.completeReady && (!fence || fenceAttested || allowPreFenceCompletion)
      if (completed && fenceAttested) clearOfflineTargetMigrations(body.targetCellId)
      const migrationTotal = targetMigrationTotal(body.targetCellId)
      const remainingOfflineTargetMigrationsForCell =
        remainingOfflineTargetMigrationCount(body.targetCellId)
      const supersededTarget = supersede && body.targetCellId === 'target1'
      const recoveryRegistrationRead =
        recoveryRegistrationReads.get(body.targetCellId) ?? 0
      if (recoveryLeasesRefreshed) {
        recoveryRegistrationReads.set(body.targetCellId, recoveryRegistrationRead + 1)
      }
      const recoveryRegistrationSettled =
        recoveryRegistrationRead >= recoveryRegistrationDelayReads
      const remainingMigrations = supersededTarget
        ? supersessionRemaining
        : completed
          ? remainingOfflineTargetMigrationsForCell + unregisteredTargetMigrations
          : migrationTotal
      const registeredMigrations = supersededTarget
        ? supersessionRemaining
        : drained
          ? remainingMigrations - unregisteredTargetMigrations
          : Math.min(
              remainingMigrations,
              preexistingRegisteredMigrations +
                (recoveryLeasesRefreshed && recoveryRegistrationSettled
                  ? publishedMigrations.get(body.targetCellId) ?? 0
                  : 0)
            )
      const completableMigrations =
        drained && !completed
          ? migrationTotal -
            remainingOfflineTargetMigrationsForCell -
            unregisteredTargetMigrations -
            registeredSourceActive
          : recoveryLeasesRefreshed
            ? Math.max(
                0,
                registeredMigrations -
                  remainingOfflineTargetMigrationsForCell -
                  registeredSourceActive
              )
            : 0
      if (completed) {
        if (failAfterDrain) return response({ error: 'injected_completion_failure' }, 500)
        if (fenceAttested) fencedCompletions++
        cells.source.activityLeases = 0
        for (const targetCellId of Object.keys(cells).filter((id) => id !== 'source')) {
          cells[targetCellId].activityLeases = 2
        }
      }
      timeline.push({
        kind: 'evacuation_status',
        targetCellId: body.targetCellId,
        completeReady: body.completeReady,
        inProgress: remainingMigrations,
        registeredTargetInactive: remainingOfflineTargetMigrationsForCell
      })
      return response({
        v: 1,
        inProgress: remainingMigrations,
        oldestExpiresAt:
          remainingMigrations === 0 ? null : Date.now() + currentLeaseRemainingMs,
        oldestRemainingMs:
          remainingMigrations === 0 ? null : currentLeaseRemainingMs,
        targetRegistered: registeredMigrations,
        registeredSourceActive,
        registeredCompletable: completableMigrations,
        registeredTargetInactive: remainingOfflineTargetMigrationsForCell,
        completed:
          completed
            ? migrationTotal -
              remainingOfflineTargetMigrationsForCell -
              unregisteredTargetMigrations
            : 0,
        blocked: completed ? remainingOfflineTargetMigrationsForCell : 0,
        expiredUnregistered: 0,
        repairableExpiredUnregistered: 0,
        abortableExpiredUnregistered: 0,
        blockedExpiredUnregistered: 0,
        blockedExpiredOnNewerTargetAssignment: 0
      })
    }
    if (parsed.pathname === '/v1/admin/migration-supersede-cell') {
      const superseded = cleanupBeforeSupersession ? 0 : supersessionRemaining
      supersessionRemaining = 0
      return response({ v: 1, superseded })
    }
    if (parsed.pathname === '/v1/admin/drain') {
      drainGraces.push(body.graceMs)
      if (loseDrainBeforeAccept && body.graceMs === 120_000) {
        throw new Error('injected_drain_response_loss')
      }
      drained = true
      cells.source.draining = true
      cells.source.activityLeases = 0
      cells.source.controls = 0
      for (const targetCellId of Object.keys(cells).filter((id) => id !== 'source')) {
        cells[targetCellId].totalConnections = 2
      }
      return response({ ok: true })
    }
    return response({ error: 'unexpected_request' }, 500)
  }
  return {
    overrides: {
      commandJson,
      terraform: (args) => {
        if (args.includes('console')) return 'true\n'
        if (args.includes('plan')) return ''
        if (args.includes('show') && args.length > 3) {
          return JSON.stringify({ resource_changes: [] })
        }
        if (args.includes('show')) {
          return JSON.stringify({
            values: {
              root_module: {
                resources: [
                  {
                    address:
                      'google_compute_instance_group_manager.relay_gce_cell["source"]',
                    values: {
                      name: topologyValue.source.mig_name,
                      zone: topologyValue.source.zone,
                      instance_group: topologyValue.source.instance_group,
                      target_size: migSizes.source,
                      version: [
                        { instance_template: topologyValue.source.generation_identity }
                      ]
                    }
                  }
                ]
              }
            }
          })
        }
        throw new Error(`unexpected terraform command: ${args.join(' ')}`)
      },
      command: (args) => {
        throw new Error(`unexpected direct gcloud mutation: ${args.join(' ')}`)
      },
      terraformFenceApply: async (fenceConfig, callbacks) => {
        const attempt = {
          attemptId: '44444444-4444-4444-8444-444444444444',
          environment: fenceConfig.environment,
          cellId: fenceConfig.cell.cellId,
          cellIncarnation: fenceConfig.cellIncarnation,
          migName: fenceConfig.cell.migName,
          instanceGroup: fenceConfig.cell.instanceGroup,
          generationIdentity: fenceConfig.cell.generationIdentity,
          fenceCommit: fenceConfig.fenceCommit,
          planSha256: 'd'.repeat(64),
          planObjectName:
            `terraform/state/relay-fence-plans/${fenceConfig.environment}/44444444-4444-4444-8444-444444444444.tfplan`,
          planObjectGeneration: '123456789',
          varFileSha256: 'e'.repeat(64),
          terraformStateLineage: '55555555-5555-4555-8555-555555555555',
          terraformStateSerial: 7,
          terraformStateObjectGeneration: '987654321',
          terraformStateObjectSha256: 'f'.repeat(64),
          requestReason:
            'orca-relay-fence/44444444-4444-4444-8444-444444444444'
        }
        await callbacks.prepareAttempt(attempt)
        await callbacks.preApplyGuard()
        const invocation = {
          invocationId: '66666666-6666-4666-8666-666666666666',
          requestReason:
            `${attempt.requestReason}/66666666-6666-4666-8666-666666666666`
        }
        await callbacks.markApplyStarted(attempt, invocation)
        const cellId = fenceConfig.cell.cellId
        migSizes[cellId] = 0
        instanceCounts[cellId] = 0
        cells[cellId].heartbeatFresh = false
        resizeAttempts++
        if (loseResizeResponse && resizeAttempts === 1) {
          throw new Error('injected_resize_response_loss')
        }
        const completed = { ...attempt, gceOperation: 'operation-1' }
        await callbacks.markOperation(completed, invocation)
        await callbacks.postApplyGuard(attempt.cellIncarnation)
        await callbacks.attest(completed)
      },
      terraformFenceAdopt: async (fenceConfig, callbacks) => {
        assert.equal(await callbacks.loadAttempt(), null)
        await callbacks.assertCommittedFenceSet()
        await callbacks.preApplyGuard()
        await callbacks.assertStateFenced()
        await callbacks.postApplyGuard(fenceConfig.cellIncarnation)
        assert.equal(await callbacks.loadAttempt(), null)
        await callbacks.attest(fenceConfig.cellIncarnation)
        await callbacks.postApplyGuard(fenceConfig.cellIncarnation)
        await callbacks.commitAdoption(fenceConfig.cellIncarnation)
        callbacks.emit({
          event: 'terraform_cell_fence_legacy_adopted',
          cellId: fenceConfig.cell.cellId
        })
      },
      terraformFenceResume: async (fenceConfig, callbacks) => {
        const attempt = await callbacks.loadAttempt()
        if (resumeNeedsPreApply) await callbacks.preApplyGuard()
        const completed = {
          ...attempt,
          cellIncarnation: fenceConfig.cellIncarnation,
          gceOperation: 'operation-1'
        }
        await callbacks.postApplyGuard(completed.cellIncarnation)
        await callbacks.attest(completed)
      },
      terraformFenceRecoverCompleted: async (
        fenceConfig,
        callbacks,
        recovery
      ) => {
        const attempt = await callbacks.loadAttempt()
        callbacks.emit({
          event: 'terraform_cell_fence_completed_attempt_recovered',
          cellId: fenceConfig.cell.cellId,
          attemptId: attempt.attemptId,
          gceOperation: recovery.gceOperation
        })
      },
      terraformFenceAbort: async (fenceConfig, callbacks) => {
        await callbacks.abortAttempt()
        callbacks.emit({
          event: 'terraform_fence_aborted_before_apply',
          cellId: fenceConfig.cell.cellId
        })
      },
      terraformFenceSupersede: async (fenceConfig, callbacks) => {
        const attempt = await callbacks.loadAttempt()
        await callbacks.abortAttempt(attempt)
        callbacks.emit({
          event: 'terraform_fence_superseded_before_upload',
          cellId: fenceConfig.cell.cellId,
          previousFenceCommit: attempt.fenceCommit,
          fenceCommit: fenceConfig.fenceCommit
        })
      },
      identityToken: () => 'aaa.bbb.ccc',
      mutationIdentityToken: () => 'ddd.eee.fff',
      resolve4: async () => ['203.0.113.10'],
      fetch,
      emit: (event) => {
        events.push(event)
        timeline.push({ kind: 'event', event })
      },
      wait: async () => undefined,
      random: () => 0
    },
    batches,
    events,
    stateChanges,
    drainGraces,
    timeline,
    fencedCompletions: () => fencedCompletions,
    capacityReads: () => capacityReads,
    selector: () => selector,
    addedCells: () => addedCells,
    runtimeInspections
  }
}

test('parses deterministic target sets with single-cell selector exceptions', () => {
  const common = [
    '--project',
    'project',
    '--director-origin',
    'https://relay.example.com',
    '--admin-audience',
    'https://relay.example.com/v1/admin/drain',
    '--topology-file',
    'topology.json',
    '--source-cell-id',
    'source',
    '--runtime-service-account',
    runtimeServiceAccount,
    '--mode',
    'preflight'
  ]
  assert.deepEqual(
    parseMultiTargetArguments([...common, '--target-cell-ids', 'target2,target1']).targetCellIds,
    ['target1', 'target2']
  )
  assert.throws(
    () => parseMultiTargetArguments([...common, '--target-cell-ids', 'target1']),
    /at least 2/
  )
  const cutover = [
    ...common.slice(0, -2),
    '--mode',
    'cutover-admission',
    '--target-cell-ids',
    'target1,target2',
    '--general-cell-ids',
    'general',
    '--director-region',
    'us-central1',
    '--director-service',
    'relay-director',
    '--director-min-instances',
    '5'
  ]
  assert.throws(
    () => parseMultiTargetArguments(cutover),
    /unobserved-connection-bound/
  )
  assert.equal(
    parseMultiTargetArguments([
      ...cutover,
      '--unobserved-connection-bound',
      '40'
    ]).unobservedConnectionBound,
    40
  )
  const recovery = [
    ...common.slice(0, -2),
    '--mode',
    'recover-forward',
    '--target-cell-ids',
    'target1,target2'
  ]
  assert.throws(
    () => parseMultiTargetArguments(recovery),
    /unobserved-connection-bound/
  )
  assert.equal(
    parseMultiTargetArguments([
      ...recovery,
      '--unobserved-connection-bound',
      '60'
    ]).unobservedConnectionBound,
    60
  )
  const fenceSource = [
    ...common.slice(0, -2),
    '--mode',
    'fence-source',
    '--target-cell-ids',
    'target1,target2',
    '--fence-commit',
    'a'.repeat(40)
  ]
  assert.throws(
    () => parseMultiTargetArguments(fenceSource),
    /unobserved-connection-bound/
  )
  assert.equal(
    parseMultiTargetArguments([
      ...fenceSource,
      '--unobserved-connection-bound',
      '60'
    ]).unobservedConnectionBound,
    60
  )
  const addCells = [
    ...common.slice(0, -2),
    '--mode',
    'add-migration-cells',
    '--target-cell-ids',
    'target1,target2',
    '--director-region',
    'us-central1',
    '--director-service',
    'relay-director',
    '--director-min-instances',
    '5',
    '--unobserved-connection-bound',
    '40'
  ]
  assert.throws(
    () => parseMultiTargetArguments(addCells),
    /selector-attempt-id/
  )
  assert.equal(
    parseMultiTargetArguments([
      ...addCells,
      '--target-cell-ids',
      'target1',
      '--selector-attempt-id',
      'add_cells_parse'
    ]).targetCellIds.length,
    1
  )
  const retireCell = [
    ...common.slice(0, -2),
    '--mode',
    'retire-migration-cell',
    '--target-cell-ids',
    'target1',
    '--director-region',
    'us-central1',
    '--director-service',
    'relay-director',
    '--director-min-instances',
    '5',
    '--selector-attempt-id',
    'retire_cell_parse'
  ]
  assert.equal(
    parseMultiTargetArguments(retireCell).mode,
    'retire-migration-cell'
  )
  assert.throws(
    () =>
      parseMultiTargetArguments([
        ...retireCell,
        '--target-cell-ids',
        'target1,target2'
      ]),
    /exactly one/
  )
  const promoteCell = [
    ...common.slice(0, -2),
    '--mode',
    'promote-general-cell',
    '--target-cell-ids',
    'target1',
    '--director-region',
    'us-central1',
    '--director-service',
    'relay-director',
    '--director-min-instances',
    '5',
    '--selector-attempt-id',
    'promote_cell_parse'
  ]
  assert.equal(
    parseMultiTargetArguments(promoteCell).mode,
    'promote-general-cell'
  )
  assert.throws(
    () =>
      parseMultiTargetArguments([
        ...promoteCell,
        '--target-cell-ids',
        'target1,target2'
      ]),
    /exactly one/
  )
})

test('requires a complete exact completed-fence recovery pin set', () => {
  const args = [
    '--project',
    'project',
    '--director-origin',
    'https://relay.example.com',
    '--admin-audience',
    'https://relay.example.com/v1/admin/drain',
    '--topology-file',
    'topology.json',
    '--source-cell-id',
    'source',
    '--target-cell-ids',
    'target1,target2',
    '--runtime-service-account',
    runtimeServiceAccount,
    '--mode',
    'supersede-target',
    '--failed-target-cell-id',
    'target1',
    '--replacement-target-cell-id',
    'target2',
    '--fence-commit',
    'a'.repeat(40),
    '--completed-fence-attempt-id',
    '44444444-4444-4444-8444-444444444444',
    '--completed-fence-commit',
    'b'.repeat(40),
    '--completed-fence-operation',
    'operation-1',
    '--completed-fence-state-serial',
    '61',
    '--completed-fence-plan-generation',
    '123',
    '--completed-fence-state-generation',
    '456',
    '--completed-fence-state-sha256',
    'c'.repeat(64),
    '--fence-broker-service-account',
    'fence-broker@example.gserviceaccount.com'
  ]
  assert.equal(
    parseMultiTargetArguments(args).completedFenceRecovery
      .terraformStateSerial,
    61
  )
  assert.throws(
    () => parseMultiTargetArguments(args.slice(0, -2)),
    /recovery inputs are invalid/
  )
})

test('requires the cutover source to remain existing-only', () => {
  assert.throws(
    () =>
      cutoverMembership(topology(), {
        sourceCellId: 'source',
        targetCellIds: ['target1'],
        generalCellIds: ['source', 'target2']
      }),
    /source must remain existing-only/
  )
})

test('requires exact cutover connection-capacity evidence and live headroom', () => {
  const status = {
    draining: false,
    connectionCapacity: {
      hardCap: 600,
      controlRebindReserve: 100,
      ordinaryConnectionLimit: 500,
      unobservedBound: 40,
      normalAdmissionPause: 460,
      pendingControlReservations: 20,
      heartbeatFresh: true
    },
    runtimeConnectionCapacity: {
      hardCap: 600,
      controlRebindReserve: 100,
      ordinaryConnectionLimit: 500,
      unobservedBound: 40,
      normalAdmissionPause: 460
    },
    process: {
      enforcedConnectionUnits: 400,
      preAuthConnections: 3
    }
  }
  assert.doesNotThrow(() => assertCutoverCellReady('target1', status, 40))
  assert.throws(
    () =>
      assertCutoverCellReady(
        'target1',
        {
          ...status,
          runtimeConnectionCapacity: {
            ...status.runtimeConnectionCapacity,
            unobservedBound: 39
          }
        },
        40
      ),
    /reviewed connection-capacity policy/
  )
  assert.throws(
    () =>
      assertCutoverCellReady(
        'target1',
        {
          ...status,
          connectionCapacity: {
            ...status.connectionCapacity,
            pendingControlReservations: 60
          }
        },
        40
      ),
    /normal-admission connection headroom/
  )
  assert.throws(
    () =>
      assertCutoverCellReady(
        'target1',
        {
          ...status,
          process: { ...status.process, preAuthConnections: 45 }
        },
        40
      ),
    /pre-auth connection headroom/
  )
})

test('cuts over only after every proposed cell passes exact readiness evidence', async () => {
  await withTopology(async (file) => {
    const testHarness = harness()
    await runMultiTargetDeployment(
      config(file, 'cutover-admission'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.selector(), {
      generation: 1,
      attemptId: testHarness.selector().attemptId,
      membership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    assert.equal(testHarness.events.at(-1).event, 'admission_selector_cutover')
    assert.deepEqual(Object.fromEntries(testHarness.runtimeInspections), {
      target1: 2,
      target2: 2,
      general: 2
    })
  })
})

test('rejects a different active selector before readiness checks or revision mutation', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source', 'target2'],
        migrationOnly: ['target1'],
        general: ['general']
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'cutover-admission'),
        testHarness.overrides
      ),
      /already active with different membership/
    )
    assert.equal(testHarness.runtimeInspections.size, 0)
  })
})

test('registers new Terraform targets as one selector generation', async () => {
  await withTopology(async (file) => {
    const reviewed = topology()
    reviewed.target1.connection_hard_cap = 1_000
    reviewed.target1.connection_unobserved_bound = 60
    writeFileSync(file, JSON.stringify(reviewed))
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: [],
        general: ['general']
      },
      activeDirectorMinimum: 5
    })
    await runMultiTargetDeployment(
      { ...config(file, 'add-migration-cells'), directorMinimumInstances: 5 },
      testHarness.overrides
    )
    assert.deepEqual(testHarness.selector(), {
      generation: 2,
      attemptId: 'add_cells_test',
      membership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    assert.equal(testHarness.events.at(-1).event, 'migration_cells_added')
    assert.deepEqual(testHarness.addedCells(), [
      {
        cellId: 'target1',
        cellUrl: topology().target1.origin,
        capacityRequests: 4_000,
        region: 'us-central1',
        connectionHardCap: 1_000,
        connectionUnobservedBound: 60
      },
      {
        cellId: 'target2',
        cellUrl: topology().target2.origin,
        capacityRequests: 4_000,
        region: 'us-central1',
        connectionHardCap: 600,
        connectionUnobservedBound: 40
      }
    ])
    assert.equal(testHarness.runtimeInspections.size, 0)
  })
})

test('promotes exactly one healthy migration cell to general admission', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'promote-general-cell'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.selector(), {
      generation: 2,
      attemptId: 'promote_cell_test',
      membership: {
        existingOnly: ['source'],
        migrationOnly: ['target2'],
        general: ['general', 'target1']
      }
    })
    assert.equal(testHarness.events.at(-1).event, 'migration_cell_promoted_general')
  })
})

test('rejects promotion below the configured director floor', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(
        { ...config(file, 'promote-general-cell'), directorMinimumInstances: 2 },
        testHarness.overrides
      ),
      /active director is not compatible/
    )
    assert.equal(testHarness.events.length, 0)
  })
})

test('rejects general promotion unless the exact cell is migration-only', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target2'],
        general: ['general', 'target1']
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'promote-general-cell'),
        testHarness.overrides
      ),
      /must be migration-only/
    )
    assert.equal(testHarness.events.length, 0)
  })
})

test('retires exactly one migration cell without changing other membership', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'retire-migration-cell'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.selector(), {
      generation: 2,
      attemptId: 'retire_cell_test',
      membership: {
        existingOnly: ['source', 'target1'],
        migrationOnly: ['target2'],
        general: ['general']
      }
    })
    assert.equal(testHarness.events.at(-1).event, 'migration_cell_retired')
    assert.equal(testHarness.runtimeInspections.size, 0)
  })
})

test('rejects retirement unless the exact cell is migration-only', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target2'],
        general: ['general', 'target1']
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'retire-migration-cell'),
        testHarness.overrides
      ),
      /must be migration-only/
    )
    assert.equal(testHarness.events.length, 0)
  })
})

test('rejects overlapping generations and allocates below the connection ceiling', () => {
  const selected = selectMultiTargetDeployments(topology(), 'source', ['target1', 'target2'])
  assert.equal(selected.targets.length, 2)
  const planned = allocateTargetQuotas({
    sourceAssignments: 4,
    sourceConnections: 5,
    requiredTargetUnits: 8,
    connectionCeiling: 6,
    targets: [
      {
        cellId: 'target1',
        currentConnections: 0,
        availableConnectionReservations: 10,
        availableTargetUnits: 10
      },
      {
        cellId: 'target2',
        currentConnections: 0,
        availableConnectionReservations: 10,
        availableTargetUnits: 10
      }
    ]
  })
  assert.deepEqual(
    planned.map(({ cellId, quota, projectedConnections }) => ({
      cellId,
      quota,
      projectedConnections
    })),
    [
      { cellId: 'target1', quota: 2, projectedConnections: 3 },
      { cellId: 'target2', quota: 2, projectedConnections: 3 }
    ]
  )
  assert.throws(() =>
    allocateTargetQuotas({
      sourceAssignments: 4,
      sourceConnections: 20,
      requiredTargetUnits: 8,
      connectionCeiling: 4,
      targets: [
        {
          cellId: 'target1',
          currentConnections: 0,
          availableConnectionReservations: 10,
          availableTargetUnits: 10
        },
        {
          cellId: 'target2',
          currentConnections: 0,
          availableConnectionReservations: 10,
          availableTargetUnits: 10
        }
      ]
    })
  )
  assert.deepEqual(
    allocateTargetQuotas({
      sourceAssignments: 1,
      sourceConnections: 700,
      requiredTargetUnits: 1,
      connectionCeiling: 1_000,
      targets: [
        {
          cellId: 'target-600',
          currentConnections: 0,
          connectionCeiling: 600,
          availableConnectionReservations: 1,
          availableTargetUnits: 1
        },
        {
          cellId: 'target-1000',
          currentConnections: 0,
          connectionCeiling: 1_000,
          availableConnectionReservations: 1,
          availableTargetUnits: 1
        }
      ]
    }).map(({ cellId, projectedConnections }) => ({ cellId, projectedConnections })),
    [
      { cellId: 'target-600', projectedConnections: 699 },
      { cellId: 'target-1000', projectedConnections: 700 }
    ]
  )
})

test('assumes every unbound source connection can land on one target', () => {
  const targets = [
    {
      cellId: 'target1',
      currentConnections: 0,
      availableConnectionReservations: 10,
      availableTargetUnits: 10
    },
    {
      cellId: 'target2',
      currentConnections: 0,
      availableConnectionReservations: 10,
      availableTargetUnits: 10
    }
  ]
  const planned = allocateTargetQuotas({
    sourceAssignments: 4,
    sourceConnections: 9,
    requiredTargetUnits: 8,
    connectionCeiling: 8,
    targets
  })
  assert.deepEqual(
    planned.map(({ quota, projectedConnections }) => ({ quota, projectedConnections })),
    [
      { quota: 2, projectedConnections: 7 },
      { quota: 2, projectedConnections: 7 }
    ]
  )
  assert.throws(() =>
    allocateTargetQuotas({
      sourceAssignments: 4,
      sourceConnections: 9,
      requiredTargetUnits: 8,
      connectionCeiling: 7,
      targets
    })
  )
})

test('serializes deterministic target quotas and completes after drain acceptance', async () => {
  await withTopology(async (file) => {
    const testHarness = harness()
    await runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides)
    assert.deepEqual(testHarness.batches, [
      ['target1', 2],
      ['target2', 2]
    ])
    assert.deepEqual(testHarness.stateChanges.slice(0, 3), [
      ['source', false],
      ['target1', true],
      ['target2', true]
    ])
    assert.equal(testHarness.events.some((event) => event.event === 'source_drain_accepted'), true)
    assert.equal(testHarness.events.at(-1).event, 'multi_target_complete')
  })
})

test('uses fresh aggregate logs for a legacy source without runtime counts', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ legacySource: true })
    await runMultiTargetDeployment(config(file), testHarness.overrides)
    assert.equal(testHarness.events.at(-1).sourceConnections, 5)
  })
})

test('rejects stale legacy source telemetry', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ legacySource: true, legacyMetricAgeMs: 90_001 })
    await assert.rejects(
      runMultiTargetDeployment(config(file), testHarness.overrides),
      /runtime metrics are stale/
    )
  })
})

test('refuses a drain with an expiring lease and restores pre-drain admission', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ leaseRemainingMs: 599_999 })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides),
      /insufficient time/
    )
    assert.deepEqual(testHarness.stateChanges.slice(-3), [
      ['source', true],
      ['target1', false],
      ['target2', false]
    ])
    assert.equal(
      testHarness.events.some((event) => event.event === 'source_drain_accepted'),
      false
    )
  })
})

test('preserves forward recovery when target registration status is unavailable', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ failEvacuationStatus: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides),
      /cannot prove zero target registrations/
    )
    assert.equal(
      testHarness.stateChanges.some(([cellId, enabled]) => cellId === 'source' && enabled),
      false
    )
    assert.equal(
      testHarness.stateChanges.some(
        ([cellId, enabled]) => cellId.startsWith('target') && !enabled
      ),
      false
    )
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'multi_forward_recovery_required',
      targetRegistered: null,
      reason: 'registration_status_unavailable'
    })
  })
})

test('audits partial migration state without requiring new migration headroom', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      capacitySourceAssignments: [1_000],
      capacityRequiredTargetUnits: [2_000]
    })
    await runMultiTargetDeployment(config(file, 'audit'), testHarness.overrides)
    assert.equal(testHarness.capacityReads(), 0)
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'multi_target_audit',
      inProgress: 4,
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
    })
  })
})

test('never restores source admission after drain acceptance', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ failAfterDrain: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides),
      /injected_completion_failure/
    )
    assert.equal(testHarness.events.some((event) => event.event === 'source_drain_accepted'), true)
    assert.equal(
      testHarness.stateChanges.some(([cellId, enabled]) => cellId === 'source' && enabled),
      false
    )
    assert.equal(testHarness.events.at(-1).event, 'multi_forward_recovery_required')
  })
})

test('never restores source admission after the send transition becomes ambiguous', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ loseDrainSendResponse: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides),
      /injected_send_transition_response_loss/
    )
    assert.equal(
      testHarness.stateChanges.some(([cellId, enabled]) => cellId === 'source' && enabled),
      false
    )
    assert.equal(testHarness.events.at(-1).event, 'multi_forward_recovery_required')
  })
})

test('freezes forward recovery when a legacy drain response is ambiguous', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ loseDrainBeforeAccept: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'execute'), testHarness.overrides),
      /injected_drain_response_loss/
    )
    assert.equal(
      testHarness.stateChanges.some(([cellId, enabled]) => cellId === 'source' && enabled),
      false
    )
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'recover-forward'), testHarness.overrides),
      /drain_application_receipt_missing/
    )
    assert.deepEqual(testHarness.drainGraces, [120_000])
  })
})

test('resumes an exact prepared drain without allocating new migrations', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      preparedDrainAttempt: true,
      preexistingRegisteredMigrations: 2,
      sourceAssignments: 0,
      sourceRequiredTargetUnits: 0,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [120_000])
    assert.deepEqual(testHarness.batches, [])
    assert.equal(testHarness.capacityReads(), 8)
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'source_prepared_drain_recovered'
      ),
      true
    )
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'multi_target_complete',
      sourceCellId: 'source'
    })
  })
})

test('registers only remaining assignments before recovering a replacement drain', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 1,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.batches, [
      ['target1', 2],
      ['target2', 2]
    ])
    assert.equal(testHarness.capacityReads(), 8)
    assert.deepEqual(testHarness.drainGraces, [0])
    const eventNames = testHarness.events.map((event) => event.event)
    assert.equal(
      testHarness.events.find(
        (event) => event.event === 'multi_forward_recovery_preflight'
      ).targetRegistered,
      2
    )
    assert.ok(
      eventNames.lastIndexOf('multi_migration_batch') <
        eventNames.indexOf('multi_forward_recovery_ready_to_drain')
    )
    assert.ok(
      eventNames.indexOf('multi_forward_recovery_ready_to_drain') <
        eventNames.indexOf('source_recovery_drain_accepted')
    )
  })
})

test('refreshes registered migration leases before the recovery drain gate', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 2,
      sourceAssignments: 0,
      sourceRequiredTargetUnits: 0,
      leaseRemainingMs: 599_999,
      refreshedLeaseRemainingMs: 900_000,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('waits for catch-up migrations to gain durable target ownership', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      recoveryRegistrationDelayReads: 2,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    const ownershipEvents = testHarness.events.filter(
      (event) => event.event === 'multi_recovery_target_ownership'
    )
    assert.equal(ownershipEvents.length, 3)
    assert.equal(ownershipEvents[0].inProgress > ownershipEvents[0].targetRegistered, true)
    assert.equal(ownershipEvents.at(-1).inProgress, ownershipEvents.at(-1).targetRegistered)
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('times out before drain when catch-up migrations remain unregistered', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      recoveryRegistrationDelayReads: Number.POSITIVE_INFINITY,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    let now = 0
    testHarness.overrides.now = () => now
    testHarness.overrides.wait = async (ms) => {
      now += ms
    }
    await assert.rejects(
      runMultiTargetDeployment(
        { ...config(file, 'recover-forward'), timeoutMs: 3 },
        testHarness.overrides
      ),
      /timed out waiting for recovery target ownership/
    )
    assert.deepEqual(testHarness.drainGraces, [])
  })
})

test('drains a fully unregistered recovery within the reviewed bound', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      recoveryRegistrationDelayReads: Number.POSITIVE_INFINITY,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      {
        ...config(file, 'recover-forward'),
        unobservedConnectionBound: 4
      },
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [0])
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'multi_recovery_bounded_unregistered'
      ),
      true
    )
  })
})

test('drains mixed target registrations within the unobserved bound', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 1,
      recoveryRegistrationDelayReads: Number.POSITIVE_INFINITY,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      {
        ...config(file, 'recover-forward'),
        unobservedConnectionBound: 2
      },
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [0])
    const event = testHarness.events.find(
      (entry) => entry.event === 'multi_recovery_bounded_mixed_registration'
    )
    assert.equal(event.unregistered, 2)
    assert.equal(event.targetRegistered, 2)
  })
})

test('reissues a proven non-delivered recovery drain and settles bounded offline clients', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      recoveryAlreadyAttempted: true,
      preexistingRegisteredMigrations: 1,
      unregisteredTargetMigrations: 1,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      {
        ...config(file, 'recover-forward'),
        unobservedConnectionBound: 2
      },
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [0])
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'source_recovery_drain_reissued_after_non_delivery'
      ),
      true
    )
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'multi_migration_bounded_offline_complete'
      ),
      true
    )
  })
})

test('rejects mixed target registrations above the unobserved bound', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 1,
      recoveryRegistrationDelayReads: Number.POSITIVE_INFINITY,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    let now = 0
    testHarness.overrides.now = () => now
    testHarness.overrides.wait = async (ms) => {
      now += ms
    }
    await assert.rejects(
      runMultiTargetDeployment(
        {
          ...config(file, 'recover-forward'),
          timeoutMs: 3,
          unobservedConnectionBound: 1
        },
        testHarness.overrides
      ),
      /timed out waiting for recovery target ownership/
    )
    assert.deepEqual(testHarness.drainGraces, [])
  })
})

test('times out before drain while a target registration remains source-active', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 1,
      registeredSourceActive: 1,
      recoveryRegistrationDelayReads: Number.POSITIVE_INFINITY,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    let now = 0
    testHarness.overrides.now = () => now
    testHarness.overrides.wait = async (ms) => {
      now += ms
    }
    await assert.rejects(
      runMultiTargetDeployment(
        {
          ...config(file, 'recover-forward'),
          timeoutMs: 3,
          unobservedConnectionBound: 2
        },
        testHarness.overrides
      ),
      /timed out waiting for recovery target ownership/
    )
    assert.deepEqual(testHarness.drainGraces, [])
  })
})

test('allows recovery drain with durable offline target registrations', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      offlineTargetMigrations: 1,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('catches up source assignments that arrive during recovery publication', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      sourceAssignments: 5,
      sourceRequiredTargetUnits: 10,
      capacitySourceAssignments: [4, 4, 4, 4, 1, 1, 1, 1],
      capacityRequiredTargetUnits: [8, 8, 8, 8, 2, 2, 2, 2],
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.equal(
      testHarness.batches.reduce((total, [, limit]) => total + limit, 0),
      5
    )
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'multi_forward_recovery_catch_up'
      ),
      true
    )
    assert.deepEqual(
      testHarness.events
        .filter((event) => event.event === 'multi_target_preflight')
        .map((event) => ({
          sourceConnections: event.sourceConnections,
          observedSourceConnections: event.observedSourceConnections
        })),
      [
        { sourceConnections: 5, observedSourceConnections: 5 },
        { sourceConnections: 1, observedSourceConnections: 5 }
      ]
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('replans recover-forward after transactional target headroom rejection', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      headroomFailureTarget: 'target1',
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.equal(
      testHarness.events.some(
        (event) =>
          event.event === 'multi_recovery_target_headroom_paused' &&
          event.targetCellId === 'target1'
      ),
      true
    )
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'multi_forward_recovery_catch_up'
      ),
      true
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('uses conservative changing capacity samples during recovery', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      sourceAssignments: 5,
      sourceRequiredTargetUnits: 10,
      capacitySourceAssignments: [5, 4, 5, 4],
      capacityRequiredTargetUnits: [10, 8, 10, 8],
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.equal(
      testHarness.batches.reduce((total, [, limit]) => total + limit, 0),
      5
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('requires every final recovery sample to prove zero source assignments', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      preexistingRegisteredMigrations: 2,
      sourceAssignments: 1,
      sourceRequiredTargetUnits: 2,
      capacitySourceAssignments: [1, 1, 1, 1, 0, 0, 0, 1],
      capacityRequiredTargetUnits: [2, 2, 2, 2, 0, 0, 0, 2],
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.equal(
      testHarness.events.some(
        (event) => event.event === 'multi_forward_recovery_catch_up'
      ),
      true
    )
    assert.deepEqual(testHarness.drainGraces, [0])
  })
})

test('stops after bounded recovery catch-up cannot quiesce the source', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      recoverableDrain: true,
      sourceAssignments: 10,
      sourceRequiredTargetUnits: 20,
      capacitySourceAssignments: Array.from({ length: 40 }, () => 1),
      capacityRequiredTargetUnits: Array.from({ length: 40 }, () => 2),
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'recover-forward'),
        testHarness.overrides
      ),
      /did not quiesce within bounded recovery catch-up/
    )
    assert.equal(
      testHarness.batches.reduce((total, [, limit]) => total + limit, 0),
      5
    )
    assert.deepEqual(testHarness.drainGraces, [])
  })
})

test('settles a drained source while registered target users remain offline', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      allowPreFenceCompletion: true,
      offlineTargetMigrations: 1,
      selectorMembership: {
        existingOnly: ['source'],
        migrationOnly: ['target1', 'target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'recover-forward'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.drainGraces, [])
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'multi_target_complete',
      sourceCellId: 'source'
    })
  })
})

test('fences a quiescent disabled source and completes through stale-source checks', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true })
    const authorizationByOrigin = new Map()
    const fetch = testHarness.overrides.fetch
    testHarness.overrides.fetch = async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.startsWith('/v1/admin/')) {
        authorizationByOrigin.set(
          parsed.origin,
          new Set([
            ...(authorizationByOrigin.get(parsed.origin) ?? []),
            options?.headers?.authorization
          ])
        )
      }
      return await fetch(url, options)
    }
    await runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
    assert.deepEqual(
      authorizationByOrigin.get('https://relay.example.com'),
      new Set(['Bearer aaa.bbb.ccc', 'Bearer ddd.eee.fff'])
    )
    assert.equal(authorizationByOrigin.has('https://a.relay.example.com'), false)
    assert.equal(authorizationByOrigin.has('https://b.relay.example.com'), false)
    assert.equal(authorizationByOrigin.has('https://c.relay.example.com'), false)
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'source_fenced',
      sourceCellId: 'source',
      targetSize: 0
    })
  })
})

test('adopts an already-fenced source only through the legacy no-op path', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true, alreadyFencedSource: true })
    await runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
    assert.deepEqual(
      testHarness.events.find(
        ({ event }) => event === 'terraform_cell_fence_legacy_adopted'
      ),
      { event: 'terraform_cell_fence_legacy_adopted', cellId: 'source' }
    )
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'source_fenced',
      sourceCellId: 'source',
      targetSize: 0
    })
  })
})

test('refuses to attest a fence when selected targets omit an outgoing migration', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      alreadyFencedSource: true,
      sourceOutgoingMigrations: 5
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /full migration coverage/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('clears the complete 156-row legacy backlog before reporting the source fenced', async () => {
  const rollout = topology()
  const additionalTarget = (id, hostname) => ({
    ...rollout.target2,
    origin: `https://${hostname}.relay.example.com`,
    zone: `us-central1-${hostname}`,
    mig_name: `relay-${hostname}`,
    instance_group: `https://compute.example/instanceGroups/relay-${hostname}`,
    backend_name: `relay-${hostname}`,
    backend_id: `https://compute.example/backendServices/relay-${hostname}`,
    generation_identity: `https://compute.example/instanceTemplates/relay-${hostname}-abc`,
    image: `us-central1-docker.pkg.dev/project/repo/relay@${digest(id)}`
  })
  rollout.target3 = additionalTarget('e', 'e')
  rollout.target4 = additionalTarget('f', 'f')
  rollout.target5 = additionalTarget('1', 'g')
  rollout.target6 = additionalTarget('2', 'h')
  const migrationCounts = {
    target1: 58,
    target2: 63,
    target3: 24,
    target4: 10,
    target5: 1,
    target6: 0
  }

  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      alreadyFencedSource: true,
      offlineTargetMigrationsByTarget: migrationCounts,
      topologyValue: rollout
    })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.targetCellIds = Object.keys(migrationCounts)

    await runMultiTargetDeployment(fenceConfig, testHarness.overrides)

    const sourceFencedIndex = testHarness.timeline.findIndex(
      ({ kind, event }) => kind === 'event' && event.event === 'source_fenced'
    )
    assert.notEqual(sourceFencedIndex, -1)
    let observedInitialTotal = 0
    for (const [targetCellId, initialCount] of Object.entries(migrationCounts)) {
      const initialIndex = testHarness.timeline.findIndex(
        (entry) =>
          entry.kind === 'evacuation_status' &&
          entry.targetCellId === targetCellId &&
          entry.inProgress === initialCount &&
          entry.registeredTargetInactive === initialCount
      )
      const clearedIndex = testHarness.timeline.findIndex(
        (entry) =>
          entry.kind === 'evacuation_status' &&
          entry.targetCellId === targetCellId &&
          entry.inProgress === 0
      )
      assert.notEqual(initialIndex, -1)
      observedInitialTotal += testHarness.timeline[initialIndex].inProgress
      if (initialCount > 0) assert.ok(clearedIndex > initialIndex)
      else assert.ok(clearedIndex >= initialIndex)
      assert.ok(clearedIndex < sourceFencedIndex)
    }
    assert.equal(observedInitialTotal, 156)
    assert.equal(testHarness.fencedCompletions(), 6)
  }, rollout)
})

test('refuses legacy adoption when the live MIG template changed', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      alreadyFencedSource: true,
      liveMigTemplateOverrides: {
        source: `${topology().source.generation_identity}-other`
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /source MIG fence topology is unsafe/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('fences with reviewed 600 templates during the declared 1000 rollout', async () => {
  const rollout = topology()
  for (const [cellId, cell] of Object.entries(rollout)) {
    cell.connection_unobserved_bound = 60
    if (['target1', 'target2'].includes(cellId)) cell.connection_hard_cap = 1_000
  }
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      templateUnobservedBound: 60,
      directorUnobservedBound: 60
    })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.unobservedConnectionBound = 60
    await runMultiTargetDeployment(fenceConfig, testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
  }, rollout)
})

test('fences exact configured capacity when the saved Terraform output is legacy', async () => {
  const rollout = topology()
  for (const cell of Object.values(rollout)) {
    delete cell.connection_hard_cap
    delete cell.connection_unobserved_bound
  }
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      templateUnobservedBound: 60,
      directorUnobservedBound: 60
    })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.unobservedConnectionBound = 60
    await runMultiTargetDeployment(fenceConfig, testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
  }, rollout)
})

test('refuses legacy Terraform output when live capacity differs from broker config', async () => {
  const rollout = topology()
  for (const cell of Object.values(rollout)) {
    delete cell.connection_hard_cap
    delete cell.connection_unobserved_bound
  }
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.unobservedConnectionBound = 60
    await assert.rejects(
      runMultiTargetDeployment(fenceConfig, testHarness.overrides),
      /instance template capacity differs from Terraform/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  }, rollout)
})

test('refuses explicit null capacity as a legacy Terraform output', async () => {
  const rollout = topology()
  for (const cell of Object.values(rollout)) {
    cell.connection_hard_cap = null
    cell.connection_unobserved_bound = null
  }
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      templateUnobservedBound: 60,
      directorUnobservedBound: 60
    })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.unobservedConnectionBound = 60
    await assert.rejects(
      runMultiTargetDeployment(fenceConfig, testHarness.overrides),
      /instance template capacity differs from Terraform/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  }, rollout)
})

test('refuses a mixed legacy and declared capacity topology', async () => {
  const rollout = topology()
  for (const cell of Object.values(rollout)) {
    delete cell.connection_hard_cap
    delete cell.connection_unobserved_bound
  }
  rollout.general.connection_hard_cap = null
  rollout.general.connection_unobserved_bound = null
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      templateUnobservedBound: 60,
      directorUnobservedBound: 60
    })
    const fenceConfig = config(file, 'fence-source')
    fenceConfig.unobservedConnectionBound = 60
    await assert.rejects(
      runMultiTargetDeployment(fenceConfig, testHarness.overrides),
      /instance template capacity differs from Terraform/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  }, rollout)
})

test('fences after the active template reaches the declared 1000 capacity', async () => {
  const rollout = topology()
  for (const cellId of Object.keys(rollout)) {
    rollout[cellId].connection_hard_cap = 1_000
  }
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      templateHardCap: 1_000,
      directorHardCap: 1_000
    })
    await runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
  }, rollout)
})

test('refuses a rollout predecessor whose template has the wrong bound', async () => {
  const rollout = topology()
  for (const cellId of ['target1', 'target2']) {
    rollout[cellId].connection_hard_cap = 1_000
    rollout[cellId].connection_unobserved_bound = 60
  }
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /instance template capacity is outside reviewed rollout/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  }, rollout)
})

test('refuses a rollout predecessor when the director reports another cap', async () => {
  const rollout = topology()
  for (const cellId of ['target1', 'target2']) {
    rollout[cellId].connection_hard_cap = 1_000
  }
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      directorCapacityOverrides: {
        target1: { hardCap: 1_000, unobservedBound: 40 }
      }
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /connection capacity differs from Terraform/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  }, rollout)
})

test('preserves direct target runtime reads outside fence mode', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({})
    const fetch = testHarness.overrides.fetch
    const authorizationByOrigin = new Map()
    testHarness.overrides.fetch = async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.startsWith('/v1/admin/')) {
        authorizationByOrigin.set(
          parsed.origin,
          new Set([
            ...(authorizationByOrigin.get(parsed.origin) ?? []),
            options?.headers?.authorization
          ])
        )
      }
      return await fetch(url, options)
    }

    await runMultiTargetDeployment(config(file, 'preflight'), testHarness.overrides)
    assert.deepEqual(
      authorizationByOrigin.get('https://relay.example.com'),
      new Set(['Bearer aaa.bbb.ccc'])
    )
    assert.deepEqual(
      authorizationByOrigin.get('https://b.relay.example.com'),
      new Set(['Bearer aaa.bbb.ccc'])
    )
    assert.deepEqual(
      authorizationByOrigin.get('https://c.relay.example.com'),
      new Set(['Bearer aaa.bbb.ccc'])
    )
  })
})

test('refuses to fence when a cell hostname routes to the wrong backend', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true, misroutedCell: 'target1' })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /retained route topology mismatch/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('refuses to fence when a cell route overrides the reviewed backend', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true, routeOverrideCell: 'target1' })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /retained route topology mismatch/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('refuses to fence when the live HTTPS frontend uses another URL map', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true, frontendMisbound: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /live frontend topology mismatch/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('refuses to fence when the fresh source heartbeat reports active work', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ fence: true, sourceObservedRequests: 1 })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /source fencing requires zero source-owned work/
    )
    assert.equal(testHarness.fencedCompletions(), 0)
  })
})

test('fences a quiescent source while registered target users remain offline', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      alreadyFencedSource: true,
      offlineTargetMigrations: 1
    })
    await runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'source_fenced',
      sourceCellId: 'source',
      targetSize: 0
    })
  })
})

test('refuses to fence source-active or unregistered migrations', async () => {
  for (const migrationState of [
    { registeredSourceActive: 1 },
    { unregisteredTargetMigrations: 1 }
  ]) {
    await withTopology(async (file) => {
      const testHarness = harness({ fence: true, ...migrationState })
      await assert.rejects(
        runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
        /full migration coverage and durable target ownership/
      )
    })
  }
})

test('resumes fenced completion after losing the resize response', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      fence: true,
      loseResizeResponse: true,
      resumeNeedsPreApply: true
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides),
      /injected_resize_response_loss/
    )
    await runMultiTargetDeployment(config(file, 'fence-source'), testHarness.overrides)
    assert.equal(testHarness.fencedCompletions(), 2)
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'source_fenced',
      sourceCellId: 'source',
      targetSize: 0
    })
  })
})

test('records a proven pre-apply Terraform fence abort', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ existingFenceAttempt: true })
    await runMultiTargetDeployment(
      config(file, 'abort-fence-source'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'terraform_fence_aborted_before_apply',
      cellId: 'source'
    })
  })
})

test('fences a failed registered target before aggregate supersession', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true })
    await runMultiTargetDeployment(
      config(file, 'supersede-target'),
      testHarness.overrides
    )
    assert.equal(
      testHarness.stateChanges.some(
        ([cellId, enabled]) => cellId === 'target2' && enabled
      ),
      true
    )
    assert.deepEqual(testHarness.events.at(-1), {
      event: 'registered_target_superseded',
      sourceCellId: 'source',
      failedTargetCellId: 'target1',
      replacementTargetCellId: 'target2',
      superseded: 2,
      remainingUnregistered: 0
    })
    assert.equal(testHarness.runtimeInspections.get('target2') ?? 0, 0)
  })
})

test('fails closed when cleanup wins before aggregate supersession selects rows', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      cleanupBeforeSupersession: true
    })

    await assert.rejects(
      runMultiTargetDeployment(config(file, 'supersede-target'), testHarness.overrides),
      /registered target supersession count changed/
    )
    assert.deepEqual(testHarness.events, [])
  })
})

test('does not accept a capacity predecessor for target supersession', async () => {
  const rollout = topology()
  rollout.target2.connection_hard_cap = 1_000
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'supersede-target'),
        testHarness.overrides
      ),
      /instance template capacity is outside reviewed rollout/
    )
  }, rollout)
})

test('does not accept capacity-bearing templates from legacy output for supersession', async () => {
  const rollout = topology()
  for (const cell of Object.values(rollout)) {
    delete cell.connection_hard_cap
    delete cell.connection_unobserved_bound
  }
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true })
    await assert.rejects(
      runMultiTargetDeployment(
        config(file, 'supersede-target'),
        testHarness.overrides
      ),
      /instance template capacity differs from Terraform/
    )
  }, rollout)
})

test('replaces a superseded unuploaded fence attempt before target fencing', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      supersededFenceAttempt: true
    })
    await runMultiTargetDeployment(
      config(file, 'supersede-target'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.events[0], {
      event: 'terraform_fence_superseded_before_upload',
      cellId: 'target1',
      previousFenceCommit: 'b'.repeat(40),
      fenceCommit: 'a'.repeat(40)
    })
    assert.equal(testHarness.events.at(-1).event, 'registered_target_superseded')
  })
})

test('recovers a pinned completed older fence before registered supersession', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      completedFenceAttempt: true
    })
    const deploymentConfig = config(file, 'supersede-target')
    deploymentConfig.completedFenceRecovery = {
      attemptId: '44444444-4444-4444-8444-444444444444',
      fenceCommit: 'b'.repeat(40),
      gceOperation: 'operation-1',
      terraformStateSerial: 7,
      planObjectGeneration: '123456789',
      terraformStateObjectGeneration: '222222222',
      terraformStateObjectSha256: 'c'.repeat(64),
      principalEmail: 'fence-broker@example.gserviceaccount.com'
    }

    await runMultiTargetDeployment(deploymentConfig, testHarness.overrides)

    assert.equal(
      testHarness.events[0].event,
      'terraform_cell_fence_completed_attempt_recovered'
    )
    assert.equal(testHarness.events.at(-1).event, 'registered_target_superseded')
  })
})

test('fails supersession on stale replacement heartbeat without calling its admin API', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      replacementHeartbeatFresh: false
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'supersede-target'), testHarness.overrides),
      /no fresh matching director runtime snapshot/
    )
    assert.equal(testHarness.runtimeInspections.get('target2') ?? 0, 0)
    assert.deepEqual(testHarness.events, [])
  })
})

test('fails supersession on mismatched director runtime without calling cell admin', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      replacementRuntimeCellUrl: 'https://wrong.relay.example.com'
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'supersede-target'), testHarness.overrides),
      /no fresh matching director runtime snapshot/
    )
    assert.equal(testHarness.runtimeInspections.get('target2') ?? 0, 0)
    assert.deepEqual(testHarness.events, [])
  })
})

test('reads the broker mutation token without treating the audience as the environment', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true })
    delete testHarness.overrides.mutationIdentityToken
    const previous = process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN
    process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN = 'ddd.eee.fff'
    try {
      await runMultiTargetDeployment(
        config(file, 'supersede-target'),
        testHarness.overrides
      )
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN
      } else {
        process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN = previous
      }
    }
    assert.equal(testHarness.events.at(-1).event, 'registered_target_superseded')
  })
})

test('fails closed when the broker child has no mutation token', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true })
    delete testHarness.overrides.mutationIdentityToken
    const previous = process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN
    delete process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN
    try {
      await assert.rejects(
        runMultiTargetDeployment(
          config(file, 'supersede-target'),
          testHarness.overrides
        ),
        /requires a broker mutation identity token/
      )
    } finally {
      if (previous !== undefined) {
        process.env.ORCA_RELAY_FENCE_MUTATION_ID_TOKEN = previous
      }
    }
    assert.equal(testHarness.events.length, 0)
  })
})

test('uses Terraform fencing for selector-era target supersession', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      selectorMembership: {
        existingOnly: ['source', 'target1'],
        migrationOnly: ['target2'],
        general: ['general']
      }
    })
    await runMultiTargetDeployment(
      config(file, 'supersede-target'),
      testHarness.overrides
    )
    assert.deepEqual(testHarness.stateChanges, [])
    assert.equal(testHarness.events.at(-1).event, 'registered_target_superseded')
  })
})

test('resumes failed-target supersession after losing the resize response', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      supersede: true,
      loseResizeResponse: true
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'supersede-target'), testHarness.overrides),
      /injected_resize_response_loss/
    )
    await runMultiTargetDeployment(
      config(file, 'supersede-target'),
      testHarness.overrides
    )
    assert.equal(testHarness.events.at(-1).event, 'registered_target_superseded')
  })
})

test('refuses to fence a failed target while its admission remains enabled', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ supersede: true, failedTargetEnabled: true })
    await assert.rejects(
      runMultiTargetDeployment(config(file, 'supersede-target'), testHarness.overrides),
      /failed target admission must be disabled/
    )
    assert.equal(testHarness.events.length, 0)
  })
})

test('retries until two complete target-capacity rounds agree', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({ capacitySourceAssignments: [4, 3] })
    await runMultiTargetDeployment(config(file), testHarness.overrides)
    assert.equal(testHarness.capacityReads(), 8)
    assert.equal(testHarness.events.at(-1).sourceAssignments, 4)
  })
})

test('fails closed after bounded inconsistent target-capacity rounds', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      capacitySourceAssignments: Array.from(
        { length: 12 },
        (_, index) => index % 2 === 0 ? 4 : 3
      )
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file), testHarness.overrides),
      /target capacity snapshots disagree/
    )
    assert.equal(testHarness.capacityReads(), 12)
    assert.deepEqual(testHarness.stateChanges, [])
  })
})

test('emits aggregate capacity inputs before rejecting insufficient headroom', async () => {
  await withTopology(async (file) => {
    const testHarness = harness({
      capacityRequiredTargetUnits: Array.from({ length: 4 }, () => 20_000)
    })
    await assert.rejects(
      runMultiTargetDeployment(config(file), testHarness.overrides),
      /multi-target connection or request-unit headroom exhausted/
    )
    const snapshot = testHarness.events.at(-1)
    assert.equal(snapshot.event, 'multi_target_capacity_snapshot')
    assert.equal(snapshot.sourceConnections, 5)
    assert.equal(snapshot.sourceAssignments, 4)
    assert.equal(snapshot.requiredTargetUnits, 20_000)
    assert.deepEqual(snapshot.targets, [
      {
        cellId: 'target1',
        currentConnections: 0,
        availableConnectionReservations: 460,
        availableTargetUnits: 4_000
      },
      {
        cellId: 'target2',
        currentConnections: 0,
        availableConnectionReservations: 460,
        availableTargetUnits: 4_000
      }
    ])
  })
})

test('rejects quotas above enforced target reservation headroom', () => {
  assert.throws(
    () =>
      allocateTargetQuotas({
        sourceAssignments: 3,
        sourceConnections: 3,
        requiredTargetUnits: 3,
        connectionCeiling: 600,
        targets: [
          {
            cellId: 'target1',
            currentConnections: 0,
            availableConnectionReservations: 1,
            availableTargetUnits: 10
          },
          {
            cellId: 'target2',
            currentConnections: 0,
            availableConnectionReservations: 1,
            availableTargetUnits: 10
          }
        ]
      }),
    /multi-target connection or request-unit headroom exhausted/
  )
})
