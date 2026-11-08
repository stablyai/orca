import type { DirectSshAuthority, SshConnectionState } from '../../../shared/ssh-types'
import { quitTeardownStartGate } from '../../startup/quit/quit-teardown-start-gate'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../../ssh/ssh-provider-authority'

// Preserve credential tracking across macOS window recreation.
export const credentialRequestedForTarget = new Set<string>()

// Coalesce tab connects; disconnect must invalidate late continuations before replacement.
export type ConnectAttempt = {
  authority: DirectSshAuthority
  promise: Promise<SshConnectionState>
  /** A retry no user asked for, while `active`: no setup progress, and refusal keeps the host. */
  quiet?: QuietConnect
}

/** A user's connect joining the attempt clears `active`, making it an ordinary connect. */
export type QuietConnect = {
  active: boolean
  /** The attempt rotated its authority only once its move succeeded. */
  rotated: (authority: DirectSshAuthority) => void
}

export const connectInFlight = new Map<string, ConnectAttempt>()

// Reuse committed-quit authority; a private latch could permanently fence connects without an actual quit.
export function assertSshConnectsNotFenced(): void {
  if (quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH connects are closed for app shutdown')
  }
}

export function invalidateConnectAttempt(targetId: string): void {
  rotateSshProviderAuthority(targetId)
  connectInFlight.delete(targetId)
  credentialRequestedForTarget.delete(targetId)
}

export function isCurrentConnectAttempt(targetId: string, authority: DirectSshAuthority): boolean {
  return authority.targetId === targetId && isCurrentSshProviderAuthority(authority)
}

// Connects admitted under the authority an unlink fenced, valid only while its successor is current.
const carriedAdmissions = new Map<string, { from: DirectSshAuthority; to: DirectSshAuthority }>()

/**
 * Fences the connect already running, unlike a Disconnect, which also cancels Connects queued
 * behind it: a Connect the user asks for while a server is unlinked must still run afterwards.
 */
export function fenceRunningConnectAttempt(targetId: string): void {
  const from = getSshProviderAuthority(targetId)
  invalidateConnectAttempt(targetId)
  carriedAdmissions.set(targetId, { from, to: getSshProviderAuthority(targetId) })
}

/** The authority a queued connect may proceed under, or null when a disconnect or reset fenced it. */
export function admittedConnectAuthority(
  targetId: string,
  admission: DirectSshAuthority
): DirectSshAuthority | null {
  if (isCurrentConnectAttempt(targetId, admission)) {
    return admission
  }
  const carried = carriedAdmissions.get(targetId)
  if (
    carried &&
    carried.from.providerEpoch === admission.providerEpoch &&
    carried.from.connectionGeneration === admission.connectionGeneration &&
    isCurrentConnectAttempt(targetId, carried.to)
  ) {
    return carried.to
  }
  return null
}

// Test probes must not flash worktree cards through connected/disconnected broadcasts.
export const testingTargets = new Set<string>()
export const testConnectionProbes = new Set<Promise<unknown>>()
const testConnectionProbesByTarget = new Map<string, Set<Promise<unknown>>>()

export function runSshTestConnectionProbe<T>(
  targetId: string,
  operation: () => Promise<T>
): Promise<T> {
  const probes = testConnectionProbesByTarget.get(targetId) ?? new Set<Promise<unknown>>()
  let probe!: Promise<T>
  // Publish before connection callbacks can start a reset or shutdown drain.
  probe = Promise.resolve()
    .then(operation)
    .finally(() => {
      testConnectionProbes.delete(probe)
      probes.delete(probe)
      if (probes.size === 0 && testConnectionProbesByTarget.get(targetId) === probes) {
        testConnectionProbesByTarget.delete(targetId)
        testingTargets.delete(targetId)
        credentialRequestedForTarget.delete(targetId)
      }
    })
  probes.add(probe)
  testConnectionProbesByTarget.set(targetId, probes)
  testConnectionProbes.add(probe)
  testingTargets.add(targetId)
  return probe
}
