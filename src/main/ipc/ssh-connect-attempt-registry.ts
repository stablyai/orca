import type { DirectSshAuthority, SshConnectionState } from '../../shared/ssh-types'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import {
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'

// Why: keep this outside registerSshHandlers so a BrowserWindow recreation mid-connect doesn't split credential tracking.
export const credentialRequestedForTarget = new Set<string>()

// Why: tabs must share one connect, while a disconnect must invalidate that
// attempt so its late continuation cannot clobber a replacement.
export type ConnectAttempt = {
  authority: DirectSshAuthority
  promise: Promise<SshConnectionState>
}

export const connectInFlight = new Map<string, ConnectAttempt>()
export const pendingTransportReconnects = new Set<string>()

// Why the quit gate rather than a local latch: "the committed quit has begun" already has an owner,
// and a private copy could be set by something that is not actually quitting — leaving SSH connects
// refused for the rest of the process lifetime.
export function assertSshConnectsNotFenced(): void {
  if (quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH connects are closed for app shutdown')
  }
}

export function invalidateConnectAttempt(targetId: string): void {
  rotateSshProviderAuthority(targetId)
  pendingTransportReconnects.delete(targetId)
  connectInFlight.delete(targetId)
  credentialRequestedForTarget.delete(targetId)
}

export function isCurrentConnectAttempt(targetId: string, authority: DirectSshAuthority): boolean {
  return authority.targetId === targetId && isCurrentSshProviderAuthority(authority)
}

// Why: publish reset's teardown/force-stop/disconnect lifecycle so new connects and duplicate resets can't race it.
export const resetRelayInFlight = new Map<string, Promise<void>>()

// Why: ssh:testConnection connects then disconnects; suppressing broadcasts during the test avoids worktree cards flashing connected → disconnected.
export const testingTargets = new Set<string>()
export const testConnectionProbes = new Set<Promise<unknown>>()
