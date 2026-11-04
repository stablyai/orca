import { beforeEach, describe, expect, it, vi } from 'vitest'

const wake = vi.hoisted(() => vi.fn())
vi.mock('../managed-server/lifecycle/orcad-managed-wake', () => ({
  wakeExpectedOrcadUnderOneFence: wake
}))

import { emptyOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import type { OrcadDeployResult } from '../ssh/orcad-remote-deploy'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { deployWslOrcadWithOneFence } from './wsl-orcad-one-fence-deploy'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake is mocked, so the slot is only passed through.
const slot = {} as OrcadSlotOptions
const record = { ...emptyOrcadActivationRecord(), active: '0.1.0+aa' }
const alreadyActive: OrcadDeployResult = { outcome: 'already-active', fullVersion: '0.1.0+aa' }
const deploy = vi.fn(async (): Promise<OrcadDeployResult> => alreadyActive)
const open = { preRead: { record, fenceOpen: true } }

beforeEach(() => {
  vi.clearAllMocks()
  wake.mockResolvedValue({ outcome: 'started', readiness: {} })
})

describe('deployWslOrcadWithOneFence', () => {
  it('deploys without a fence and wakes under one, for a same-version connect', async () => {
    await expect(deployWslOrcadWithOneFence(slot, deploy, open)).resolves.toEqual({
      deployed: alreadyActive,
      woken: true
    })
    expect(deploy.mock.calls).toEqual([[{ ...open, sameVersionFencedByCaller: true }]])
    expect(wake).toHaveBeenCalledWith(slot, '0.1.0+aa')
  })

  it.each(['replan', 'fenced'])(
    'runs the full deploy and wake when the fence answers %s',
    async (outcome) => {
      wake.mockResolvedValueOnce({ outcome })
      await expect(deployWslOrcadWithOneFence(slot, deploy, open)).resolves.toEqual({
        deployed: alreadyActive,
        woken: false
      })
      expect(deploy.mock.calls.at(-1)).toEqual([{}])
    }
  )

  it('keeps the two-fence path when the snapshot saw the fence held or gave no hints', async () => {
    for (const hinted of [{ preRead: { record, fenceOpen: false } }, {}]) {
      deploy.mockClear()
      await expect(deployWslOrcadWithOneFence(slot, deploy, hinted)).resolves.toMatchObject({
        woken: false
      })
      expect(deploy.mock.calls).toEqual([[hinted]])
    }
    expect(wake).not.toHaveBeenCalled()
  })

  it('wakes nothing when the deploy activated or deferred a new version', async () => {
    deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: 'x',
      verdict: { decision: 'activate', coverage: 'pty-spawn', warnings: [] }
    })
    await expect(deployWslOrcadWithOneFence(slot, deploy, open)).resolves.toMatchObject({
      woken: false
    })
    expect(wake).not.toHaveBeenCalled()
  })
})
