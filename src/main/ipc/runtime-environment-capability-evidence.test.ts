import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import {
  advanceRuntimeEnvironmentCapabilityIncarnation,
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  isRuntimeEnvironmentCapabilityOutcomeCurrent,
  isRuntimeEnvironmentCapabilityPaused,
  resetRuntimeEnvironmentCapabilityEvidence,
  runtimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

beforeEach(resetRuntimeEnvironmentCapabilityEvidence)

describe('runtime environment capability evidence', () => {
  it('accepts evidence by dispatch order instead of completion order', () => {
    const older = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    const newer = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    const pause = vi.fn()

    expect(
      applyRuntimeEnvironmentCapabilityVerdict({
        evidence: newer,
        verdict: 'capable',
        runtimeId: 'runtime-new'
      })
    ).toBe(true)
    expect(
      applyRuntimeEnvironmentCapabilityVerdict({
        evidence: older,
        verdict: 'absent',
        runtimeId: 'runtime-old',
        onAbsent: pause
      })
    ).toBe(false)

    expect(pause).not.toHaveBeenCalled()
    expect(isRuntimeEnvironmentCapabilityPaused('env')).toBe(false)
  })

  it('rejects an older same-verdict outcome from a different runtime identity', () => {
    const older = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    const newer = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: newer,
      verdict: 'capable',
      runtimeId: 'runtime-new'
    })

    expect(
      isRuntimeEnvironmentCapabilityOutcomeCurrent(
        runtimeEnvironmentCapabilityOutcome(older, 'capable', 'runtime-old')
      )
    ).toBe(false)
  })

  it('rejects every pre-invalidation completion, including a same-pairing cycle', () => {
    const evidence = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    advanceRuntimeEnvironmentCapabilityIncarnation('env')

    expect(
      applyRuntimeEnvironmentCapabilityVerdict({
        evidence,
        verdict: 'capable',
        runtimeId: 'runtime-old'
      })
    ).toBe(false)
    expect(
      isRuntimeEnvironmentCapabilityOutcomeCurrent(
        runtimeEnvironmentCapabilityOutcome(evidence, 'capable', 'runtime-old')
      )
    ).toBe(false)
  })

  it('invalidates cached outcomes symmetrically on contradictory evidence', () => {
    const supportedEvidence = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: supportedEvidence,
      verdict: 'capable',
      runtimeId: 'runtime'
    })
    const supported = runtimeEnvironmentCapabilityOutcome(supportedEvidence, 'capable', 'runtime')
    const absentEvidence = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: absentEvidence,
      verdict: 'absent',
      runtimeId: 'runtime'
    })

    expect(isRuntimeEnvironmentCapabilityOutcomeCurrent(supported)).toBe(false)
    expect(isRuntimeEnvironmentCapabilityPaused('env')).toBe(true)
    expect(
      getAcceptedRuntimeEnvironmentCapabilityOutcome('env', pairing(), 'runtime')
    ).toMatchObject({
      kind: 'unsupported'
    })

    const recoveredEvidence = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: recoveredEvidence,
      verdict: 'capable',
      runtimeId: 'runtime'
    })
    expect(
      isRuntimeEnvironmentCapabilityOutcomeCurrent(
        runtimeEnvironmentCapabilityOutcome(absentEvidence, 'absent', 'runtime')
      )
    ).toBe(false)
    expect(
      getAcceptedRuntimeEnvironmentCapabilityOutcome('env', pairing(), 'runtime')
    ).toMatchObject({
      kind: 'supported'
    })
  })

  it('does not reuse accepted evidence across runtime identities', () => {
    const evidence = captureRuntimeEnvironmentCapabilityEvidence('env', pairing())
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence,
      verdict: 'capable',
      runtimeId: 'runtime-a'
    })

    expect(
      getAcceptedRuntimeEnvironmentCapabilityOutcome('env', pairing(), 'runtime-a')
    ).toMatchObject({
      kind: 'supported'
    })
    expect(getAcceptedRuntimeEnvironmentCapabilityOutcome('env', pairing(), 'runtime-b')).toBeNull()
  })
})

function pairing(): PairingOffer {
  return {
    v: 2,
    endpoint: 'ws://host',
    deviceToken: 'token',
    publicKeyB64: 'key'
  }
}
