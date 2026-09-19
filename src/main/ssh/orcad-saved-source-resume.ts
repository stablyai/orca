import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { normalizeSshPtyConsumerRecovery } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import { connectOrcadSavedSshSource } from './orcad-saved-source-connection'
import { resumeSshPtyConsumerSession } from './ssh-pty-consumer-session'
import type { OrcadSuccessorRetirementSession } from './orcad-successor-retirement-client'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'

/** Caller retains native successor, exact source and complete cohort authority throughout use. */
export async function resumeOrcadSavedSshSource(
  options: Omit<Parameters<typeof connectOrcadSavedSshSource>[0], 'initialize'> & {
    store: Pick<Store, 'getSshPtyConsumerRecovery' | 'upsertSshPtyConsumerRecovery'>
    ownerLease: string
  }
) {
  const { store, targetId, signal, assertAuthority } = options
  const source = { ...options.source }
  const recovery = normalizeSshPtyConsumerRecovery(store.getSshPtyConsumerRecovery(targetId))
  if (
    !recovery ||
    recovery.targetId !== targetId ||
    recovery.ownerLease !== options.ownerLease ||
    recovery.serverBuildId !== source.incumbentVersion
  ) {
    throw new Error('orcad_saved_source_owner_required')
  }
  let expected = serializeOrcadMigrationValue(recovery)
  const assertRecovery = () => {
    signal.throwIfAborted()
    assertAuthority()
    if (!isPtyOwnershipTransferMutationEnabled()) {
      throw new Error('pty_ownership_transfer_mutation_disabled')
    }
    if (serializeOrcadMigrationValue(store.getSshPtyConsumerRecovery(targetId)) !== expected) {
      throw new Error('orcad_saved_source_owner_changed')
    }
  }
  assertRecovery()
  const transport = await connectOrcadSavedSshSource({
    ...options,
    source,
    assertAuthority: assertRecovery,
    initialize: () => {}
  })
  try {
    transport.assertCurrent()
    const admission = await resumeSshPtyConsumerSession(transport.mux, {
      clientInstanceId: recovery.clientInstanceId,
      expectedServerBuildId: recovery.serverBuildId,
      resume: { ownerGeneration: recovery.ownerGeneration, ownerLease: recovery.ownerLease },
      ...(recovery.outputFlowControl
        ? { outputFlowControl: { requestedWindowSu: recovery.outputFlowControl.windowSu } }
        : {}),
      signal,
      assertAuthority: transport.assertCurrent
    })
    transport.assertCurrent()
    if (admission.state.mode !== 'negotiated' || !admission.resumed) {
      throw new Error('orcad_saved_source_resume_required')
    }
    const { mode: _mode, ...claim } = admission.state
    const current = { ...claim, targetId, serverBuildId: recovery.serverBuildId }
    expected = serializeOrcadMigrationValue(current)
    await store.upsertSshPtyConsumerRecovery(current)
    transport.assertCurrent()
    const owner = Object.freeze({
      ...admission.state,
      ...(admission.state.outputFlowControl
        ? { outputFlowControl: Object.freeze({ ...admission.state.outputFlowControl }) }
        : {})
    })
    const session: OrcadSuccessorRetirementSession = Object.freeze({
      targetId,
      mux: transport.mux,
      connection: transport.connection,
      transportGeneration: transport.transportGeneration,
      owner,
      resumed: true
    })
    return { ...transport, session }
  } catch (error) {
    transport.dispose()
    throw error
  }
}
