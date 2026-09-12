import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import type { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'

type Fixture = {
  activate: Awaited<ReturnType<typeof controlReleaseFixture>>['activate']
  run: (operation: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[1]) => Promise<unknown>
}

export function registerLiveRestartClaimTests(prepare: () => Promise<Fixture>) {
  it.each(['claim', 'publication', 'catalog', 'identity'] as const)(
    'refuses conflicting %s before restart work',
    async (kind) => {
      const f = await prepare()
      const activate = f.activate.getMockImplementation()!
      f.activate.mockImplementationOnce(async (...args) => {
        const result = structuredClone(await activate(...args))
        if (kind === 'claim') {
          result.destinationClaim = { generation: 1, claimId: 'replacement' }
        }
        if (kind === 'publication') {
          result.publicationReceipt.publicationReceiptId = 'replacement'
        }
        if (kind === 'catalog') {
          result.catalog.manifestSha256 = '0'.repeat(64)
        }
        if (kind === 'identity') {
          result.identity = { ...result.identity, incarnationId: 'replacement' }
        }
        return result
      })
      const callback = vi.fn(async () => {})
      await expect(f.run(callback)).rejects.toThrow(
        kind === 'claim' ? 'activation_regressed' : 'activation_'
      )
      expect(callback).not.toHaveBeenCalled()
    }
  )
}
