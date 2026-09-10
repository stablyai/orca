import type { PairingOffer } from '../../shared/pairing'

export type RuntimeEnvironmentCapabilityVerdict = 'capable' | 'absent'

export type RuntimeEnvironmentCapabilityEvidence = {
  environmentId: string
  pairingKey: string
  epoch: number
  sequence: number
}

export type RuntimeEnvironmentCapabilityOutcome =
  | { kind: 'supported'; evidence: RuntimeEnvironmentCapabilityEvidence; runtimeId: string }
  | { kind: 'unsupported'; evidence: RuntimeEnvironmentCapabilityEvidence; runtimeId: string }
  | { kind: 'stale_incarnation' }

type AcceptedEvidence = {
  evidence: RuntimeEnvironmentCapabilityEvidence
  verdict: RuntimeEnvironmentCapabilityVerdict
  runtimeId: string
}

type EvidenceState = {
  epoch: number
  nextSequence: number
  accepted: AcceptedEvidence | null
}

const evidenceByEnvironment = new Map<string, EvidenceState>()

export function resetRuntimeEnvironmentCapabilityEvidence(): void {
  evidenceByEnvironment.clear()
}

export function clearRuntimeEnvironmentCapabilityEvidence(environmentId: string): void {
  evidenceByEnvironment.delete(environmentId)
}

function stateFor(environmentId: string): EvidenceState {
  let state = evidenceByEnvironment.get(environmentId)
  if (!state) {
    state = { epoch: 0, nextSequence: 0, accepted: null }
    evidenceByEnvironment.set(environmentId, state)
  }
  return state
}

export function captureRuntimeEnvironmentCapabilityEvidence(
  environmentId: string,
  pairing: PairingOffer
): RuntimeEnvironmentCapabilityEvidence {
  const state = stateFor(environmentId)
  return {
    environmentId,
    pairingKey: pairingKey(pairing),
    epoch: state.epoch,
    sequence: ++state.nextSequence
  }
}

export function advanceRuntimeEnvironmentCapabilityIncarnation(environmentId: string): void {
  const state = stateFor(environmentId)
  state.epoch += 1
  state.accepted = null
}

export function applyRuntimeEnvironmentCapabilityVerdict(args: {
  evidence: RuntimeEnvironmentCapabilityEvidence
  verdict: RuntimeEnvironmentCapabilityVerdict
  runtimeId: string
  onCapable?: () => void
  onAbsent?: () => void
}): boolean {
  const state = stateFor(args.evidence.environmentId)
  if (
    args.evidence.epoch !== state.epoch ||
    (state.accepted !== null && args.evidence.sequence <= state.accepted.evidence.sequence)
  ) {
    return false
  }
  state.accepted = {
    evidence: args.evidence,
    verdict: args.verdict,
    runtimeId: args.runtimeId
  }
  if (args.verdict === 'capable') {
    args.onCapable?.()
  } else {
    args.onAbsent?.()
  }
  return true
}

export function runtimeEnvironmentCapabilityOutcome(
  evidence: RuntimeEnvironmentCapabilityEvidence,
  verdict: RuntimeEnvironmentCapabilityVerdict,
  runtimeId: string
): RuntimeEnvironmentCapabilityOutcome {
  return {
    kind: verdict === 'capable' ? 'supported' : 'unsupported',
    evidence,
    runtimeId
  }
}

export function getAcceptedRuntimeEnvironmentCapabilityOutcome(
  environmentId: string,
  pairing: PairingOffer,
  runtimeId: string | null
): RuntimeEnvironmentCapabilityOutcome | null {
  const accepted = stateFor(environmentId).accepted
  if (
    !accepted ||
    accepted.evidence.pairingKey !== pairingKey(pairing) ||
    (runtimeId !== null && accepted.runtimeId !== runtimeId)
  ) {
    return null
  }
  return runtimeEnvironmentCapabilityOutcome(
    accepted.evidence,
    accepted.verdict,
    accepted.runtimeId
  )
}

export function isRuntimeEnvironmentCapabilityOutcomeCurrent(
  outcome: RuntimeEnvironmentCapabilityOutcome
): boolean {
  if (outcome.kind === 'stale_incarnation') {
    return false
  }
  const state = stateFor(outcome.evidence.environmentId)
  if (outcome.evidence.epoch !== state.epoch) {
    return false
  }
  const accepted = state.accepted
  if (!accepted || accepted.evidence.sequence <= outcome.evidence.sequence) {
    return true
  }
  return (
    ((outcome.kind === 'supported' && accepted.verdict === 'capable') ||
      (outcome.kind === 'unsupported' && accepted.verdict === 'absent')) &&
    accepted.runtimeId === outcome.runtimeId
  )
}

export function isRuntimeEnvironmentCapabilityPaused(environmentId: string): boolean {
  return stateFor(environmentId).accepted?.verdict === 'absent'
}

function pairingKey(pairing: PairingOffer): string {
  return [pairing.endpoint, pairing.deviceToken, pairing.publicKeyB64].join('\0')
}
