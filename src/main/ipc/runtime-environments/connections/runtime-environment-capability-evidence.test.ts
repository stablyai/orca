import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PairingOffer } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
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
    const older = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )
    const newer = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )

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
        runtimeId: 'runtime-old'
      })
    ).toBe(false)

    expect(isRuntimeEnvironmentCapabilityPaused('env')).toBe(false)
  })

  it('rejects every pre-invalidation completion, including a same-pairing cycle', () => {
    const evidence = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )
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
    const supportedEvidence = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: supportedEvidence,
      verdict: 'capable',
      runtimeId: 'runtime'
    })
    const supported = runtimeEnvironmentCapabilityOutcome(supportedEvidence, 'capable', 'runtime')
    const absentEvidence = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: absentEvidence,
      verdict: 'absent',
      runtimeId: 'runtime'
    })

    expect(isRuntimeEnvironmentCapabilityOutcomeCurrent(supported)).toBe(false)
    expect(isRuntimeEnvironmentCapabilityPaused('env')).toBe(true)
    expect(
      getAcceptedRuntimeEnvironmentCapabilityOutcome(
        'env',
        pairedRuntimeConnectionFromOffer(pairing()),
        'runtime'
      )
    ).toMatchObject({
      kind: 'unsupported'
    })

    const recoveredEvidence = captureRuntimeEnvironmentCapabilityEvidence(
      'env',
      pairedRuntimeConnectionFromOffer(pairing())
    )
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
      getAcceptedRuntimeEnvironmentCapabilityOutcome(
        'env',
        pairedRuntimeConnectionFromOffer(pairing()),
        'runtime'
      )
    ).toMatchObject({
      kind: 'supported'
    })
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
