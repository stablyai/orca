import { beforeEach, expect, it, vi } from 'vitest'
import { withOrcadLiveSourceCutover } from './orcad-live-source-cutover'

const f = vi.hoisted(() => ({
  authority: vi.fn(),
  resolve: vi.fn(),
  bind: vi.fn(),
  admit: vi.fn()
}))
vi.mock('./orcad-outgoing-authority', () => ({ withOutgoingOrcadAuthority: f.authority }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: f.resolve }))
vi.mock('./orcad-outgoing-catalog-source', () => ({ bindOutgoingOrcadCatalogSource: f.bind }))
vi.mock('./orcad-live-cutover-admission', () => ({ beginOrcadLiveSourceCutoverDurably: f.admit }))

beforeEach(() => {
  vi.resetAllMocks()
  f.resolve.mockReturnValue({ id: 'environment' })
})

it('passes initial selection evidence into lifecycle authority before source fencing', async () => {
  const assertEvidence = vi.fn(() => {
    throw new Error('destination_changed')
  })
  f.authority.mockImplementation(async (_profile, args) => args.assertEvidence())
  await expect(
    withOrcadLiveSourceCutover(
      {
        profileDirectory: 'profile',
        selector: 'environment',
        targetId: 'target',
        migrationId: 'migration',
        signal: new AbortController().signal,
        store: { getSshTarget: () => ({ id: 'target', generation: 1 }) } as never,
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
        ],
        assertEvidence
      },
      vi.fn()
    )
  ).rejects.toThrow('destination_changed')
  expect(assertEvidence).toHaveBeenCalledOnce()
  expect(f.bind).not.toHaveBeenCalled()
  expect(f.admit).not.toHaveBeenCalled()
})
