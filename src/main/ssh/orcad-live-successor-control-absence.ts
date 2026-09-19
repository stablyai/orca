import { getSshConnectionManager } from './ssh-target-registry'
import { getSshProviderAuthority, isCurrentSshProviderAuthority } from './ssh-provider-authority'
import { hasSshProviderContinuations } from './ssh-provider-continuations'
import { assertSshBrowserResourcesAbsent } from '../browser/ssh-browser-route-lifetimes'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshPtyProvider, sshProvidersByGeneration } from '../ipc/pty/provider/registry'
import { activeSessions } from '../ipc/ssh-active-relay-sessions'
import { portForwardManager } from '../ipc/ssh-ipc-context'
import { assertSshResetAdmissionAllowed } from '../ipc/ssh-reset-production-state'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  pendingTransportReconnects,
  resetRelayInFlight,
  hasSshTestConnectionProbes,
  testingTargets
} from '../ipc/ssh-connect-attempt-registry'

/** Current-process control absence only; caller retains profile/lifecycle exclusion independently. */
export function bindOrcadLiveSuccessorControlAbsence(options: {
  targetId: string
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const { targetId, signal, assertAuthority } = options
  signal.throwIfAborted()
  assertAuthority()
  const manager = getSshConnectionManager()
  const forwards = portForwardManager
  if (!targetId.trim() || !manager || !forwards) {
    throw new Error('orcad_live_successor_control_context_unavailable')
  }
  const providerAuthority = { ...getSshProviderAuthority(targetId) }
  const assertContext = () => {
    signal.throwIfAborted()
    assertAuthority()
    assertSshConnectsNotFenced()
    assertSshResetAdmissionAllowed(targetId)
    if (
      getSshConnectionManager() !== manager ||
      portForwardManager !== forwards ||
      !isCurrentSshProviderAuthority(providerAuthority)
    ) {
      throw new Error('orcad_live_successor_control_context_changed')
    }
  }
  const assertResources = () => {
    manager.assertTargetTransportsClosed(targetId)
    assertSshBrowserResourcesAbsent(targetId)
    for (const provider of new Set(sshProvidersByGeneration.values())) {
      const owner =
        provider && 'getConnectionId' in provider && typeof provider.getConnectionId === 'function'
          ? provider.getConnectionId()
          : null
      if (typeof owner !== 'string' || !owner.trim() || owner === targetId) {
        throw new Error('orcad_live_successor_control_retained_provider')
      }
    }
    if (
      manager.hasTargetActivity(targetId) ||
      activeSessions.has(targetId) ||
      connectInFlight.has(targetId) ||
      pendingTransportReconnects.has(targetId) ||
      resetRelayInFlight.has(targetId) ||
      testingTargets.has(targetId) ||
      hasSshTestConnectionProbes(targetId) ||
      hasSshProviderContinuations(targetId) ||
      getSshPtyProvider(targetId) ||
      getSshFilesystemProvider(targetId) ||
      getSshGitProvider(targetId)
    ) {
      throw new Error('orcad_live_successor_controls_retained')
    }
  }
  const assertAbsent = () => {
    assertContext()
    assertResources()
    forwards.assertTargetResourcesAbsent(targetId)
    assertResources()
    assertContext()
  }
  assertAbsent()
  return { assertAbsent }
}
