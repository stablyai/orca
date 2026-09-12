import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  authority: vi.fn(),
  list: vi.fn(),
  persist: vi.fn(),
  provider: vi.fn(),
  prepare: vi.fn(),
  current: vi.fn(),
  retire: vi.fn(),
  retired: vi.fn(),
  restore: vi.fn(),
  checkpointRead: vi.fn(),
  checkpointPersist: vi.fn(),
  record: {
    sha256: 'digest',
    release: { cutover: { manifest: { source: { sshTargetId: 'target' } } } }
  },
  preparation: { receipts: [{ identity: { bridgeId: 'bridge' } }] }
}))
vi.mock('./orcad-live-runtime-restart-readiness', () => ({
  withOrcadLiveRuntimeRestartReadiness: (
    _options: unknown,
    operation: (value: unknown) => unknown
  ) =>
    operation({ record: f.record, outputEvidence: { settlements: [] }, assertCurrent: f.authority })
}))
vi.mock('./orcad-live-source-completion-evidence', () => ({
  createOrcadLiveSourceCompletionEvidence: () => ({ version: 1 })
}))
vi.mock('../ipc/pty/provider/registry', () => ({ getSshPtyProvider: f.provider }))
vi.mock('../ipc/pty/provider/outgoing-source-route-retirement', () => ({
  prepareOutgoingSshPtyRouteRetirement: f.prepare,
  restoreRetiredOutgoingSshPtyRoutes: f.restore
}))
vi.mock('./orcad-live-source-route-checkpoint', () => ({
  createOrcadLiveSourceRouteCheckpoint: () => ({ identity: { bridgeId: 'bridge' } }),
  OrcadLiveSourceRouteCheckpointStore: class {
    read = f.checkpointRead
    persist = f.checkpointPersist
  }
}))
vi.mock('./orcad-live-source-completion-preparation', () => ({
  listValidatedOrcadLiveSourceCompletionPreparations: f.list,
  OrcadLiveSourceCompletionPreparationStore: class {
    persist = f.persist
  }
}))
import { retireOrcadLiveSourceRoutes } from './orcad-live-source-route-retirement'

const options = { profileDirectory: 'unused' } as Parameters<typeof retireOrcadLiveSourceRoutes>[0]
beforeEach(() => {
  vi.resetAllMocks()
  f.list.mockReturnValue([{ record: f.record, preparation: f.preparation }])
  f.provider.mockReturnValue({ providerGeneration: 7 })
  f.checkpointRead.mockReturnValue(null)
  f.checkpointPersist.mockImplementation((value) => value)
  f.restore.mockReturnValue({ assertRetired: f.retired })
  f.prepare.mockReturnValue({
    assertCurrent: f.current,
    retire: f.retire,
    assertRetired: f.retired
  })
})

it('reflushes preparation before exact route removal without claiming migration completion', async () => {
  await expect(retireOrcadLiveSourceRoutes(options)).resolves.toEqual({
    phase: 'source-routes-removed',
    checkpoint: { identity: { bridgeId: 'bridge' } },
    completionEvidence: { version: 1 },
    sourceRetirement: 'pending'
  })
  expect(f.persist.mock.invocationCallOrder[0]).toBeLessThan(f.retire.mock.invocationCallOrder[0])
  expect(f.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      targetId: 'target',
      providerGeneration: 7,
      recordSha256: 'digest',
      identities: f.preparation.receipts.map(({ identity }) => identity)
    })
  )
  expect(f.retired).toHaveBeenCalledTimes(4)
})

it.each(['missing evidence', 'missing provider', 'flush failure', 'stale routes'] as const)(
  'refuses %s without route mutation',
  async (mode) => {
    if (mode === 'missing evidence') {
      f.list.mockReturnValue([])
    }
    if (mode === 'missing provider') {
      f.provider.mockReturnValue(undefined)
    }
    if (mode === 'flush failure') {
      f.persist.mockImplementation(() => {
        throw new Error('disk')
      })
    }
    if (mode === 'stale routes') {
      f.current.mockImplementation(() => {
        throw new Error('stale')
      })
    }
    await expect(retireOrcadLiveSourceRoutes(options)).rejects.toThrow()
    expect(f.retire).not.toHaveBeenCalled()
  }
)

it('recovers absent routes without consulting the old provider', async () => {
  f.provider.mockImplementation(() => {
    throw new Error('old provider unavailable')
  })
  await expect(
    retireOrcadLiveSourceRoutes({ ...options, recoveryOnly: true })
  ).resolves.toMatchObject({ phase: 'source-routes-removed' })
  expect(f.provider).not.toHaveBeenCalled()
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.restore).toHaveBeenCalledOnce()
  expect(f.checkpointPersist).toHaveBeenCalledOnce()
})
it('does not acknowledge a failed route-checkpoint write or retry initial removal as recovery', async () => {
  f.checkpointPersist.mockImplementation(() => {
    throw new Error('checkpoint uncertain')
  })
  await expect(retireOrcadLiveSourceRoutes(options)).rejects.toThrow('checkpoint uncertain')
  expect(f.retire).toHaveBeenCalledOnce()
  expect(f.restore).not.toHaveBeenCalled()
})
it('binds removal authority to the unchanged preparation', async () => {
  f.prepare.mockImplementation(({ assertAuthority }) => {
    f.list.mockReturnValue([])
    assertAuthority()
  })
  await expect(retireOrcadLiveSourceRoutes(options)).rejects.toThrow('preparation_required')
  expect(f.persist).not.toHaveBeenCalled()
  expect(f.retire).not.toHaveBeenCalled()
})
