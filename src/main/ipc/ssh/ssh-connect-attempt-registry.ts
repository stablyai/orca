import type { DirectSshAuthority, SshConnectionState } from '../../../shared/ssh-types'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import {
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../../ssh/ssh-provider-authority'

// Preserve credential tracking across macOS window recreation.
export const credentialRequestedForTarget = new Set<string>()

// Coalesce tab connects; disconnect must invalidate late continuations before replacement.
export type ConnectAttempt = {
  authority: DirectSshAuthority
  promise: Promise<SshConnectionState>
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
