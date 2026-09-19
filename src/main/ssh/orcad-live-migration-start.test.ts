import { beforeEach, expect, it, vi } from 'vitest'
import { startSelectedOrcadLiveMigration } from './orcad-live-migration-start'

const f = vi.hoisted(() => ({
  enabled: vi.fn(),
  resolve: vi.fn(),
  inspect: vi.fn(),
  admit: vi.fn(),
  migrate: vi.fn(),
  resume: vi.fn(),
  provider: vi.fn(),
  source: vi.fn(),
  inventory: vi.fn(),
  current: vi.fn(),
  authority: vi.fn(),
  uuid: vi.fn()
}))
vi.mock('node:crypto', () => ({ randomUUID: f.uuid }))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: f.enabled
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: f.resolve }))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: f.inspect
}))
vi.mock('./orcad-live-source-cutover', () => ({ withOrcadLiveSourceCutover: f.admit }))
vi.mock('./orcad-live-destination-coordinator', () => ({ migrateOrcadLiveDestination: f.migrate }))
vi.mock('./orcad-live-migration-selection', () => ({ resumeSelectedOrcadLiveMigration: f.resume }))
vi.mock('../ipc/pty/provider/registry', () => ({ getSshPtyProvider: f.provider }))

const context = {
  store: {} as never,
  runtime: { bindOutgoingSshPtyCatalogSurfaces: f.inventory } as never
}
const selection = { selector: 'server-name', targetId: 'target' }
const source = (terminalId = 'pty-1') => ({
  terminalId,
  incarnationId: `incarnation-${terminalId}`,
  ownerLease: 'owner',
  sourceOwnerGeneration: 1
})
const savedIdentity = { ...source(), bridgeId: 'saved-bridge', destinationRuntimeId: 'runtime' }
const environment = () => ({
  id: 'environment',
  runtimeId: 'runtime',
  createdAt: 1,
  endpoints: [],
  pairingRevision: 1
})
function retained(state = 'intent-only', destinationEnvironmentId = 'environment') {
  return {
    state,
    intent: {
      destinationEnvironmentId,
      manifest: { migrationId: 'saved-migration', source: { sshTargetId: 'target' } },
      liveTerminalBindings: [{ identity: savedIdentity }]
    },
    ...(state === 'journal-retained' ? { journal: { phase: 'destination-staged' } } : {})
  }
}
function run(signal = new AbortController().signal) {
  return startSelectedOrcadLiveMigration('profile', context, selection, signal)
}
beforeEach(() => {
  vi.resetAllMocks()
  f.enabled.mockReturnValue(true)
  f.resolve.mockImplementation(environment)
  f.inspect.mockReturnValue([])
  let sequence = 0
  f.uuid.mockImplementation(() => `generated-${++sequence}`)
  f.source.mockImplementation((id: string) => source(id))
  f.provider.mockReturnValue({ getOwnershipTransferSourceIdentity: f.source })
  f.inventory.mockReturnValue({
    surfaces: ['pty-1', 'pty-2'].map((ptyId) => ({
      ptyId,
      incarnationId: `incarnation-${ptyId}`,
      surfaceBinding: { ptyId }
    })),
    assertCurrent: f.current
  })
  f.admit.mockImplementation(async (_options, operation) =>
    operation({
      cutover: { phase: 'source-fenced' },
      pairingCode: 'secret',
      sourceAdmission: {},
      assertAuthority: f.authority
    })
  )
  f.migrate.mockImplementation(async (options) => options.assertAuthority())
  f.resume.mockResolvedValue({ sourceRetirement: 'complete' })
})

it('derives the complete provider cohort and resumes only after admission releases locks', async () => {
  let locked = false
  f.admit.mockImplementation(async (_options, operation) => {
    locked = true
    try {
      return await operation({ assertAuthority: f.authority })
    } finally {
      locked = false
    }
  })
  f.migrate.mockImplementation(async () => expect(locked).toBe(true))
  f.resume.mockImplementation(async () => {
    expect(locked).toBe(false)
    return { sourceRetirement: 'complete' }
  })
  await expect(run()).resolves.toEqual({ sourceRetirement: 'complete' })
  expect(f.admit.mock.calls[0][0]).toMatchObject({
    selector: 'environment',
    targetId: 'target',
    migrationId: 'generated-1',
    identities: ['pty-1', 'pty-2'].map((id, index) => ({
      ...source(id),
      bridgeId: `generated-${index + 2}`,
      destinationRuntimeId: 'runtime'
    }))
  })
  expect(f.current).toHaveBeenCalledOnce()
  expect(f.resume.mock.calls[0][2]).toEqual({
    selector: 'environment',
    migrationId: 'generated-1',
    mode: 'initial'
  })
})

it('reuses intent-only identities without minting IDs or reading a new cohort', async () => {
  f.inspect.mockReturnValue([retained()])
  await run()
  expect(f.admit.mock.calls[0][0]).toMatchObject({
    migrationId: 'saved-migration',
    identities: [savedIdentity]
  })
  expect(f.uuid).not.toHaveBeenCalled()
  expect(f.inventory).not.toHaveBeenCalled()
  expect(f.provider).not.toHaveBeenCalled()
})

it('resumes retained journal evidence without repeating initial admission', async () => {
  f.inspect.mockReturnValue([retained('journal-retained')])
  await run()
  expect(f.admit).not.toHaveBeenCalled()
  expect(f.migrate).not.toHaveBeenCalled()
  expect(f.uuid).not.toHaveBeenCalled()
  expect(f.resume.mock.calls[0][2].migrationId).toBe('saved-migration')
})

it.each(['intent-only', 'journal-retained'])(
  'refuses foreign destination for %s',
  async (state) => {
    f.inspect.mockReturnValue([retained(state, 'other-environment')])
    await expect(run()).rejects.toThrow('destination_changed')
    expect(f.admit).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  }
)

it('refuses a retained identity for another runtime', async () => {
  const candidate = retained()
  candidate.intent.liveTerminalBindings[0] = {
    identity: { ...savedIdentity, destinationRuntimeId: 'other-runtime' }
  }
  f.inspect.mockReturnValue([candidate])
  await expect(run()).rejects.toThrow('destination_changed')
  expect(f.uuid).not.toHaveBeenCalled()
})

it('does not restart a phase-unverifiable cutover', async () => {
  f.inspect.mockReturnValue([retained('phase-unverifiable')])
  await expect(run()).rejects.toThrow('phase_observation_required')
  expect(f.admit).not.toHaveBeenCalled()
  expect(f.resume).not.toHaveBeenCalled()
})

it('propagates corrupted evidence without admitting a replacement', async () => {
  f.inspect.mockImplementation(() => {
    throw new Error('intent_conflict')
  })
  await expect(run()).rejects.toThrow('intent_conflict')
  expect(f.uuid).not.toHaveBeenCalled()
  expect(f.admit).not.toHaveBeenCalled()
})

it.each(['disabled', 'canceled'])('refuses %s before reading state', async (mode) => {
  const controller = new AbortController()
  if (mode === 'disabled') {
    f.enabled.mockReturnValue(false)
  } else {
    controller.abort(new Error('canceled'))
  }
  await expect(run(controller.signal)).rejects.toThrow()
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.inspect).not.toHaveBeenCalled()
  expect(f.inventory).not.toHaveBeenCalled()
  expect(f.uuid).not.toHaveBeenCalled()
})

it('does not resume when cancellation arrives after destination commit', async () => {
  const controller = new AbortController()
  f.migrate.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
  expect(f.resume).not.toHaveBeenCalled()
})

it('does not acknowledge a canceled resume', async () => {
  const controller = new AbortController()
  f.resume.mockImplementation(async () => controller.abort(new Error('canceled')))
  await expect(run(controller.signal)).rejects.toThrow('canceled')
})

it('pins environment ID instead of re-resolving the caller alias after awaits', async () => {
  await run()
  expect(f.resolve.mock.calls[0]).toEqual(['profile', 'server-name'])
  expect(f.resolve.mock.calls.slice(1).every((args) => args[1] === 'environment')).toBe(true)
})

it.each(['runtimeId', 'pairingRevision'])(
  'refuses destination %s drift before publication',
  async (key) => {
    f.admit.mockImplementation(async (_options, operation) => {
      f.resolve.mockReturnValue({
        ...environment(),
        [key]: key === 'runtimeId' ? 'new-runtime' : 2
      })
      return operation({ assertAuthority: f.authority })
    })
    await expect(run()).rejects.toThrow('destination_changed')
    expect(f.migrate).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  }
)

it('refuses canary removal between stages', async () => {
  f.migrate.mockImplementation(async () => f.enabled.mockReturnValue(false))
  await expect(run()).rejects.toThrow('mutation_disabled')
  expect(f.resume).not.toHaveBeenCalled()
})

it('supplies destination evidence for authority checks before source admission', async () => {
  f.admit.mockImplementation(async (options) => {
    options.assertEvidence()
    f.resolve.mockReturnValue({ ...environment(), pairingRevision: 2 })
    options.assertEvidence()
    throw new Error('must not reach source admission')
  })
  await expect(run()).rejects.toThrow('destination_changed')
  expect(f.migrate).not.toHaveBeenCalled()
  expect(f.resume).not.toHaveBeenCalled()
})

it('propagates initial failure without resuming or rolling back', async () => {
  f.migrate.mockRejectedValue(new Error('publication_unverifiable'))
  await expect(run()).rejects.toThrow('publication_unverifiable')
  expect(f.resume).not.toHaveBeenCalled()
})

it.each(['missing', 'incarnation', 'terminal'])('refuses %s provider identity', async (mode) => {
  f.source.mockReturnValue(
    mode === 'missing'
      ? null
      : {
          ...source(),
          ...(mode === 'incarnation' ? { incarnationId: 'other' } : { terminalId: 'other' })
        }
  )
  await expect(run()).rejects.toThrow('inventory_mismatch')
  expect(f.admit).not.toHaveBeenCalled()
})

it('refuses an empty live cohort instead of fabricating a terminal', async () => {
  f.inventory.mockReturnValue({ surfaces: [], assertCurrent: f.current })
  await expect(run()).rejects.toThrow('source_unavailable')
  expect(f.admit).not.toHaveBeenCalled()
})

it('refuses inventory changes before admission', async () => {
  f.current.mockImplementation(() => {
    throw new Error('inventory_changed')
  })
  await expect(run()).rejects.toThrow('inventory_changed')
  expect(f.admit).not.toHaveBeenCalled()
})
