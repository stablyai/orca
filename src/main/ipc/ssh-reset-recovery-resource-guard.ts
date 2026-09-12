import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { hasSshProviderContinuations } from '../ssh/ssh-provider-continuations'
import { assertSshBrowserResourcesAbsent } from '../browser/ssh-browser-route-lifetimes'
import { captureSshResetProfileIdentity } from '../ssh/ssh-reset-profile-identity'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  type SshRelayResetRetirementSelection
} from '../ssh/ssh-relay-reset-retirement-record'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import { getSshPtyProvider, sshProvidersByGeneration } from './pty/provider/registry'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  pendingTransportReconnects,
  resetRelayInFlight,
  hasSshTestConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { assertSshTargetNotManagedOrPreparing } from './ssh-target-destruction-admission'

/** Current-process resource checks only; profile lifetime exclusion remains independently required. */
export function captureSshResetRecoveryResourceGuard(options: {
  intent: SshRelayResetIntent
  selection: SshRelayResetRetirementSelection
  assertReserved: () => void
  expectedReset?: Promise<void> | (() => Promise<void>)
  // Coordinators retain captured identities before a fallible first check.
  deferInitialAssertion?: boolean
}) {
  const intent = parseSshRelayResetIntent(options.intent)
  const expectedReset = options.expectedReset
  const selection = parseSshRelayResetRetirementSelection(options.selection, intent)
  const profile = getCanonicalUserDataPath()
  const registry = getSshTargetRegistryStore()
  const connections = connectionManager
  const forwards = portForwardManager
  const leases = persistedStore
  if (!registry || !connections || !forwards || !leases) {
    throw new Error('ssh_reset_recovery_resources_unavailable')
  }
  const profileIdentity = captureSshResetProfileIdentity(profile)
  const assertContext = () => {
    options.assertReserved()
    assertSshConnectsNotFenced()
    profileIdentity.assertCurrent()
    if (
      getCanonicalUserDataPath() !== profile ||
      getSshTargetRegistryStore() !== registry ||
      connectionManager !== connections ||
      portForwardManager !== forwards ||
      persistedStore !== leases
    ) {
      throw new Error('ssh_reset_recovery_context_changed')
    }
    const target = registry.getTarget(intent.targetId)
    if (
      !target ||
      target.id !== intent.targetId ||
      target.generation !== intent.targetGeneration ||
      sshRelayResetTargetRoutingDigest(target) !== intent.targetRoutingDigest
    ) {
      throw new Error('ssh_reset_recovery_target_changed')
    }
    assertSshTargetNotManagedOrPreparing(intent.targetId)
  }
  const assertRegistryAbsent = () => {
    const id = intent.targetId
    assertSshBrowserResourcesAbsent(id)
    if (hasSshProviderContinuations(id)) {
      throw new Error('ssh_reset_recovery_provider_work_pending')
    }
    const reset = typeof expectedReset === 'function' ? expectedReset() : expectedReset
    if (resetRelayInFlight.get(id) !== reset) {
      throw new Error('ssh_reset_recovery_reset_operation_changed')
    }
    if (
      activeSessions.has(id) ||
      connections.hasTargetActivity(id) ||
      connectInFlight.has(id) ||
      pendingTransportReconnects.has(id) ||
      hasSshTestConnectionProbes(id) ||
      testingTargets.has(id) ||
      getSshPtyProvider(id) ||
      getSshFilesystemProvider(id) ||
      getSshGitProvider(id) ||
      selection.routes.some((route) => sshProvidersByGeneration.has(route.providerGeneration))
    ) {
      throw new Error('ssh_reset_recovery_resources_still_retained')
    }
  }
  const assertCurrent = () => {
    assertContext()
    assertRegistryAbsent()
    forwards.assertTargetResourcesAbsent(intent.targetId)
    assertContext()
    assertRegistryAbsent()
  }
  if (!options.deferInitialAssertion) {
    assertCurrent()
  }
  return { assertCurrent, leases }
}
