import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { captureSshResetRetirementSelection } from './pty/provider/ssh-reset-selection-capture'
import { captureSshResetTransportRetirement } from './ssh-reset-captured-transport'
import { createSshResetOperation } from './ssh-reset-operation'
import type { SshResetOperationAuthority } from './ssh-reset-operation-authority'
import { getSshResetIntentStore, sshResetOperationAuthorities } from './ssh-reset-production-state'
import { assertSshTargetNotManagedOrPreparing } from './ssh-target-destruction-admission'
import { prepareSshResetProfileParticipation } from './ssh-reset-profile-participation'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

/** Caller reserves admission and joins admitted connects/probes before invoking this capture. */
export async function captureProductionSshResetOperation(
  targetId: string,
  assertReserved: () => void
) {
  assertReserved()
  const records = getSshResetIntentStore()
  const connections = connectionManager
  const forwards = portForwardManager
  const leases = persistedStore
  const registry = getSshTargetRegistryStore()
  const session = activeSessions.get(targetId)
  if (!connections || !forwards || !leases || !registry || !session) {
    throw new Error('ssh_reset_production_resources_unavailable')
  }
  const readTarget = () => registry.getTarget(targetId)
  const assertContext = () => {
    assertReserved()
    assertSshTargetNotManagedOrPreparing(targetId)
    const target = readTarget()
    if (!target) {
      throw new Error('ssh_reset_production_target_unavailable')
    }
    if (
      connectionManager !== connections ||
      portForwardManager !== forwards ||
      persistedStore !== leases ||
      getSshTargetRegistryStore() !== registry
    ) {
      throw new Error('ssh_reset_production_context_changed')
    }
  }
  assertContext()
  const binding = await session.captureResetBinding(readTarget)
  assertContext()
  binding.assertAuthority()
  if (!binding.intent.preparation) {
    throw new Error('ssh_reset_durable_preparation_required')
  }
  if (!binding.intent.destination) {
    throw new Error('ssh_reset_execution_destination_required')
  }
  if (binding.intent.preparation.readerVersion !== 1) {
    throw new Error('ssh_reset_preparation_reader_required')
  }
  let authority: SshResetOperationAuthority | undefined
  const assertAuthority = () => {
    assertContext()
    if (authority) {
      authority.assertAuthority()
    } else {
      binding.assertAuthority()
    }
  }
  const captured = captureSshResetTransportRetirement({
    targetId,
    session,
    connections,
    forwards,
    intent: binding.intent,
    assertAuthority,
    removeCapturedSession: (assertLocalRetired) => {
      if (!authority) {
        throw new Error('ssh_reset_production_authority_missing')
      }
      authority.removeCapturedSession(assertLocalRetired)
    }
  })
  const selection = captureSshResetRetirementSelection({
    intent: binding.intent,
    expectedProvider: captured.provider,
    readLeases: () => leases.getSshRemotePtyLeases(targetId),
    assertAuthority
  })
  const prepareParticipation = prepareSshResetProfileParticipation({
    root: getCanonicalUserDataPath(),
    intent: binding.intent,
    selection: selection.selection,
    assertAuthority
  })
  authority = sshResetOperationAuthorities.retain({
    intent: binding.intent,
    selection: selection.selection,
    session,
    mux: captured.mux,
    readTarget,
    assertLiveAuthority: () => {
      assertContext()
      binding.assertAuthority()
    },
    assertCapturedIdentity: () => {
      assertContext()
      captured.assertIdentity()
    }
  })
  return createSshResetOperation({
    authority,
    captured,
    records,
    leases,
    assertSelectionCurrent: selection.assertCurrent,
    prepareParticipation
  })
}
