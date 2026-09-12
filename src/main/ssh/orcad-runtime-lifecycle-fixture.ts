import { beforeEach, vi, type Mock } from 'vitest'

const hoistedMocks = vi.hoisted(() => {
  const mock = (): Mock => vi.fn()
  return {
    addEnvironment: mock(),
    beginCutover: mock(),
    closeTunnel: mock(),
    commitDestination: mock(),
    connect: mock(),
    collectCensus: mock(),
    createManifest: mock(),
    deploy: mock(),
    encodePairingOffer: mock(),
    ensureTunnel: mock(),
    getPreferredPairingOffer: mock(),
    hasDirectAuthority: mock(),
    listCutovers: mock(),
    listEnvironments: mock(),
    materialize: mock(),
    probeReadiness: mock(),
    readTransaction: mock(),
    readRecord: mock(),
    recover: mock(),
    requestDecommission: mock(),
    readManagedIdentity: mock(),
    requestManagedDecommission: mock(),
    retireSource: mock(),
    removeEnvironment: mock(),
    restoreEnvironmentLink: mock(),
    releaseTarget: mock(),
    resolveContext: mock(),
    resolveEnvironment: mock(),
    resolveNodeFallback: mock(),
    startTunnel: mock(),
    stopRemote: mock(),
    tunnelPairingCode: mock(),
    updateEnvironment: mock()
  }
})

export const mocks = hoistedMocks

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    randomUUID: () => 'environment-1'
  }
})
vi.mock('../../shared/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironment,
  listEnvironments: mocks.listEnvironments,
  removeEnvironment: mocks.removeEnvironment,
  restoreManagedOrcadEnvironmentLink: mocks.restoreEnvironmentLink,
  resolveEnvironment: mocks.resolveEnvironment,
  updateEnvironmentFromPairingCode: mocks.updateEnvironment
}))
vi.mock('../../shared/runtime-environments', () => ({
  getPreferredLoopbackRuntimePort: () => 46_768,
  getPreferredPairingOffer: mocks.getPreferredPairingOffer,
  redactRuntimeEnvironment: (environment: unknown) => environment
}))
vi.mock('../../shared/pairing', () => ({ encodePairingOffer: mocks.encodePairingOffer }))
vi.mock('./orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: mocks.materialize
}))
vi.mock('./orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: mocks.closeTunnel,
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  startOrcadManagedTunnel: mocks.startTunnel
}))
vi.mock('./orcad-active-readiness', () => ({
  probeActiveOrcadReadiness: mocks.probeReadiness
}))
vi.mock('./orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('./orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('./orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: mocks.recover
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.readTransaction
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord
}))
vi.mock('./orcad-remote-rollback', () => ({ rollbackOrcad: vi.fn() }))
vi.mock('./orcad-remote-stop', () => ({ stopRemoteOrcad: mocks.stopRemote }))
vi.mock('./orcad-decommission-client', () => ({
  requestRemoteOrcadDecommission: mocks.requestDecommission,
  readRemoteOrcadManagedStopIdentity: mocks.readManagedIdentity,
  requestRemoteOrcadManagedDecommission: mocks.requestManagedDecommission
}))
vi.mock('./orcad-slot-runtime-eligibility', () => ({
  resolveOrcadSlotNodeFallback: mocks.resolveNodeFallback
}))
vi.mock('./orcad-terminal-census-client', () => ({
  collectRemoteOrcadTerminalCensus: mocks.collectCensus
}))
vi.mock('./orcad-tunneled-pairing', () => ({
  tunneledOrcadPairingCode: mocks.tunnelPairingCode
}))
vi.mock('./orcad-migration-manifest-export', () => ({
  createOrcadMigrationManifest: mocks.createManifest
}))
vi.mock('./orcad-migration-cutover-coordinator', () => ({
  beginOrcadMigrationSourceCutoverDurably: mocks.beginCutover,
  commitOrcadMigrationDestination: mocks.commitDestination,
  retireOrcadMigrationSourceCatalogDurably: mocks.retireSource
}))

export const operationOrder: string[] = []
export const target = {
  id: 'ssh-1',
  label: 'Server',
  host: 'server.example',
  port: 22,
  username: 'deploy',
  generation: 7
}
export const claimedTarget = {
  ...target,
  owner: { type: 'orcad-runtime' as const, environmentId: 'environment-1' }
}
export const migrationManifest = {
  version: 1 as const,
  migrationId: 'migration-1',
  manifestSha256: 'a'.repeat(64),
  createdAt: '2026-08-30T00:00:00.000Z',
  source: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    targetLabel: 'Server'
  },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
}
export const sourceCutover = {
  version: 1 as const,
  phase: 'source-fenced' as const,
  destinationEnvironmentId: 'environment-1',
  destinationName: 'Managed server',
  manifest: migrationManifest,
  startedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z'
}
export const migrationStore = {
  flushPendingOrThrowAsync: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  listOrcadMigrationSourceCutovers: mocks.listCutovers
}
export const originalStopAuthority = {
  runtimeId: 'runtime',
  profileId: 'profile',
  profileRoot: '/profile',
  transactionId: 'original'
}
export const managedEnvironment = {
  id: 'environment-1',
  name: 'Managed server',
  createdAt: 1_000,
  updatedAt: 1_000,
  lastUsedAt: null,
  runtimeId: null,
  connectionDependency: 'ssh-tunnel' as const,
  orcadDeployment: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    localPort: 46_768,
    remotePort: 6_768
  },
  endpoints: [
    {
      id: 'ws-environment-1',
      kind: 'websocket' as const,
      label: 'WebSocket',
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    }
  ],
  preferredEndpointId: 'ws-environment-1'
}
export const targetStore = {
  assertOrcadRuntimeTargetClaimable: vi.fn(() => {
    operationOrder.push('assert')
    return target
  }),
  claimOrcadRuntimeTarget: vi.fn(() => {
    operationOrder.push('claim')
    return claimedTarget
  }),
  getTarget: vi.fn((_targetId: string): typeof target | typeof claimedTarget => claimedTarget),
  ensureOrcadRuntimeTargetGeneration: vi.fn(() => claimedTarget),
  getOrcadMigrationStore: vi.fn(() => migrationStore),
  releaseOrcadRuntimeTarget: mocks.releaseTarget
}

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => targetStore,
  hasRegisteredDirectSshAuthority: mocks.hasDirectAuthority
}))

export const {
  createManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus,
  listPendingManagedOrcadMigrations,
  recoverManagedOrcadEnvironment,
  updateManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment
} = await import('./orcad-runtime-lifecycle')

export const readiness = {
  type: 'orca_server_ready',
  runtimeId: 'runtime-1',
  endpoint: 'ws://127.0.0.1:6768'
}
export const environment = {
  id: 'environment-1',
  name: 'Managed server'
}

beforeEach(() => {
  vi.clearAllMocks()
  operationOrder.length = 0
  targetStore.ensureOrcadRuntimeTargetGeneration.mockImplementation(() => {
    operationOrder.push('ensure-generation')
    return claimedTarget
  })
  migrationStore.flushPendingOrThrowAsync.mockImplementation(async () => {
    operationOrder.push('flush-generation')
  })
  mocks.hasDirectAuthority.mockReturnValue(false)
  mocks.listCutovers.mockReturnValue([])
  mocks.listEnvironments.mockReturnValue([])
  mocks.createManifest.mockReturnValue(migrationManifest)
  mocks.beginCutover.mockImplementation(async () => {
    operationOrder.push('begin')
    return sourceCutover
  })
  mocks.commitDestination.mockResolvedValue(sourceCutover)
  mocks.retireSource.mockResolvedValue(sourceCutover)
  mocks.getPreferredPairingOffer.mockReturnValue({})
  mocks.encodePairingOffer.mockReturnValue('orca://pair?existing')
  mocks.connect.mockImplementation(async () => {
    operationOrder.push('connect')
    return { getTransportGeneration: () => 1 }
  })
  mocks.resolveContext.mockResolvedValue({
    activationRecord: { active: null, previous: null, activatedAt: null, snapshot: null },
    bunTarget: 'linux-x64-glibc',
    connection: {},
    host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
    remoteHome: '/home/deploy',
    target: claimedTarget,
    userDataDir: '/home/deploy/.orca'
  })
  mocks.materialize.mockResolvedValue('/local/orcad')
  mocks.deploy.mockResolvedValue({
    outcome: 'installed-and-activated',
    fullVersion: '0.1.0+abc123',
    verdict: { decision: 'accept' },
    readiness
  })
  mocks.startTunnel.mockResolvedValue(46_768)
  mocks.tunnelPairingCode.mockReturnValue('orca://pair?managed')
  mocks.addEnvironment.mockReturnValue(environment)
  mocks.removeEnvironment.mockReturnValue(managedEnvironment)
  mocks.restoreEnvironmentLink.mockReturnValue(managedEnvironment)
  mocks.updateEnvironment.mockReturnValue(managedEnvironment)
  mocks.resolveEnvironment.mockReturnValue(managedEnvironment)
  mocks.closeTunnel.mockResolvedValue(undefined)
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.collectCensus.mockResolvedValue({ liveSessions: 0, startedSinceActivation: 0 })
  mocks.stopRemote.mockResolvedValue({
    outcome: 'stopped',
    activeVersion: '0.1.0+abc123',
    alreadyDeactivated: false
  })
  mocks.releaseTarget.mockReturnValue(target)
  mocks.readTransaction.mockResolvedValue(null)
  mocks.readRecord.mockResolvedValue({
    active: null,
    previous: null,
    activatedAt: null,
    snapshot: null
  })
  mocks.recover.mockResolvedValue({ outcome: 'none' })
})
