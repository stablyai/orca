import { beforeEach, expect, it, vi } from 'vitest'
import { withOrcadLiveSourceCutover } from './orcad-live-source-cutover'

const f = vi.hoisted(() => ({
  preflight: vi.fn(),
  admit: vi.fn(),
  current: vi.fn(),
  participation: vi.fn(),
  retained: vi.fn()
}))
vi.mock('./orcad-live-profile-participation', () => ({
  prepareOrcadLiveProfileParticipation: f.participation
}))
vi.mock('./orcad-outgoing-authority', () => ({
  withOutgoingOrcadAuthority: async (_profile, args, run) =>
    run({
      pairingCode: 'paired',
      assertAuthority: args.assertEvidence,
      assertSourceCutoverOwner: args.assertEvidence
    })
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'destination' })
}))
vi.mock('./orcad-outgoing-catalog-source', () => ({
  bindOutgoingOrcadCatalogSource: () => ({ bindings: [], assertCurrent: f.current })
}))
vi.mock('./orcad-live-cutover-recovery-inspection', () => ({
  inspectOrcadLiveCutoverRecovery: () => []
}))
vi.mock('./orcad-migration-manifest-export', () => ({
  createOrcadMigrationManifest: () => ({ createdAt: '2026-09-07T00:00:00Z' })
}))
vi.mock('./orcad-live-cutover-admission', () => ({ beginOrcadLiveSourceCutoverDurably: f.admit }))
vi.mock('./orcad-live-migration-preflight', () => ({
  assertOrcadLiveMigrationPreflight: f.preflight
}))

const options = {
  profileDirectory: 'profile',
  selector: 'destination',
  targetId: 'source',
  migrationId: 'migration',
  signal: new AbortController().signal,
  store: { getSshTarget: () => ({ id: 'source', generation: 1 }) } as never,
  runtime: {} as never,
  identities: [
    {
      bridgeId: 'bridge',
      terminalId: 'terminal',
      incarnationId: 'incarnation',
      ownerLease: 'owner',
      sourceOwnerGeneration: 1,
      destinationRuntimeId: 'runtime'
    }
  ]
}
beforeEach(() => {
  vi.resetAllMocks()
  f.participation.mockReturnValue(f.retained)
})

it('waits for peer readiness before source-fencing admission', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  f.preflight.mockReturnValue(waiting)
  const continuation = vi.fn()
  const operation = withOrcadLiveSourceCutover(options, continuation)
  await vi.waitFor(() => expect(f.preflight).toHaveBeenCalledOnce())
  expect(f.admit).not.toHaveBeenCalled()
  expect(f.participation).not.toHaveBeenCalled()
  expect(continuation).not.toHaveBeenCalled()
  expect(f.preflight.mock.calls[0][0]).toMatchObject({
    pairingCode: 'paired',
    targetId: 'source',
    identities: options.identities,
    signal: options.signal,
    assertAuthority: f.current
  })
  release()
  await operation
  expect(f.current.mock.invocationCallOrder[0]).toBeLessThan(f.admit.mock.invocationCallOrder[0])
  expect(f.participation.mock.invocationCallOrder[0]).toBeLessThan(
    f.admit.mock.invocationCallOrder[0]
  )
  expect(continuation).toHaveBeenCalledOnce()
})

it.each(['unsupported', 'drift'])('does not fence when readiness reports %s', async (reason) => {
  if (reason === 'unsupported') {
    f.preflight.mockRejectedValue(new Error(reason))
  } else {
    f.preflight.mockImplementation(async () => {
      f.current.mockImplementation(() => {
        throw new Error(reason)
      })
    })
  }
  const continuation = vi.fn()
  await expect(withOrcadLiveSourceCutover(options, continuation)).rejects.toThrow(reason)
  expect(f.admit).not.toHaveBeenCalled()
  expect(continuation).not.toHaveBeenCalled()
})

it('refuses participation persistence failure before source admission', async () => {
  f.participation.mockImplementation(() => {
    throw new Error('participation write uncertain')
  })
  await expect(withOrcadLiveSourceCutover(options, vi.fn())).rejects.toThrow(
    'participation write uncertain'
  )
  expect(f.admit).not.toHaveBeenCalled()
})

it.each(['owner-transition', 'destination-continuation'])(
  'retains participation through %s',
  async (phase) => {
    f.admit.mockImplementation(async (args) => {
      args.assertAuthority('unowned')
      if (phase === 'owner-transition') {
        f.retained.mockImplementation(() => {
          throw new Error('participation lost')
        })
        args.assertAuthority('fenced')
      }
    })
    const operation = vi.fn(async (context) => {
      f.retained.mockImplementation(() => {
        throw new Error('participation lost')
      })
      context.assertAuthority()
    })
    await expect(withOrcadLiveSourceCutover(options, operation)).rejects.toThrow(
      'participation lost'
    )
    if (phase === 'owner-transition') {
      expect(operation).not.toHaveBeenCalled()
    }
  }
)
