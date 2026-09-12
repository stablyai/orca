import { describe, expect, it, vi } from 'vitest'
import { recoverInterruptedDecommission } from './orcad-decommission-recovery'
import { createOrcadDecommissionTransaction } from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from './orcad-activation-record'
import type { OrcadActivationRecoveryOptions } from './orcad-activation-recovery'

describe('legacy managed-stop recovery authority', () => {
  it.each(['recordBefore', 'acceptedRecord', 'recordAfter'] as const)(
    'retains an identity-bound transaction at %s without contacting or mutating the host',
    async (record) => {
      const before = {
        ...emptyOrcadActivationRecord(),
        active: '0.1.0+old',
        activatedAt: new Date(1).toISOString()
      }
      const accepted = withDecommissioningVersion(before, new Date(2))
      const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
      const transaction = createOrcadDecommissionTransaction({
        transactionId,
        authority: {
          runtimeId: 'runtime-a',
          profileId: 'profile-a',
          profileRoot: '/host/a',
          transactionId
        },
        activeVersion: before.active,
        recordBefore: before,
        acceptedRecord: accepted,
        recordAfter: withDeactivatedVersion(accepted),
        now: new Date(2)
      })
      const retain = vi.fn()
      const options = new Proxy({} as OrcadActivationRecoveryOptions, {
        get: () => {
          throw new Error('legacy recovery reached host operations')
        }
      })
      await expect(
        recoverInterruptedDecommission(options, transaction, transaction[record], { retain })
      ).resolves.toMatchObject({
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_authority_unavailable'
      })
      expect(retain).toHaveBeenCalledOnce()
    }
  )
})
