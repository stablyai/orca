import type { OrcaRuntimeService } from '../orca-runtime'

export type FederationAckIdentity = {
  environmentId: string
  peerFingerprint: string
  remoteRuntimeEpoch: string
}

type FederationAckCheckpoint = FederationAckIdentity & { throughSequence: number }
type FederationAckDispatchState = { checkpoint: FederationAckCheckpoint | null }
type FederationAckRuntimeState = { byDispatch: Map<string, FederationAckDispatchState> }

export type FederationAckLease = {
  runtimeState: FederationAckRuntimeState
  dispatchState: FederationAckDispatchState
}

const federationAckStates = new WeakMap<OrcaRuntimeService, FederationAckRuntimeState>()

export function clearFederationAckCheckpoints(runtime: OrcaRuntimeService): void {
  federationAckStates.delete(runtime)
}

export function acquireFederationAckLease(
  runtime: OrcaRuntimeService,
  dispatchId: string
): FederationAckLease {
  let runtimeState = federationAckStates.get(runtime)
  if (!runtimeState) {
    runtimeState = { byDispatch: new Map() }
    federationAckStates.set(runtime, runtimeState)
  }
  let dispatchState = runtimeState.byDispatch.get(dispatchId)
  if (!dispatchState) {
    dispatchState = { checkpoint: null }
    runtimeState.byDispatch.set(dispatchId, dispatchState)
  }
  return { runtimeState, dispatchState }
}

export function getFederationAckedThrough(
  lease: FederationAckLease,
  identity: FederationAckIdentity
): number {
  const checkpoint = lease.dispatchState.checkpoint
  return checkpoint?.environmentId === identity.environmentId &&
    checkpoint.peerFingerprint === identity.peerFingerprint &&
    checkpoint.remoteRuntimeEpoch === identity.remoteRuntimeEpoch
    ? checkpoint.throughSequence
    : 0
}

export function recordFederationAckCheckpoint(
  runtime: OrcaRuntimeService,
  lease: FederationAckLease,
  checkpoint: FederationAckCheckpoint
): void {
  if (federationAckStates.get(runtime) !== lease.runtimeState) {
    return
  }
  const current = lease.dispatchState.checkpoint
  if (
    current?.environmentId === checkpoint.environmentId &&
    current.peerFingerprint === checkpoint.peerFingerprint &&
    current.remoteRuntimeEpoch === checkpoint.remoteRuntimeEpoch &&
    current.throughSequence >= checkpoint.throughSequence
  ) {
    return
  }
  lease.dispatchState.checkpoint = checkpoint
}
