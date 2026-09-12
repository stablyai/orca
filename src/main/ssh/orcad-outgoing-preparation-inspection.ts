import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { PtyOwnershipTransferRequestClient } from '../providers/ssh-pty-ownership-transfer-client'
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { assertOutgoingOrcadPreparationStatusBinding } from './orcad-outgoing-preparation-status-binding'
import { OrcadOutgoingPreparationConnectionStore } from './orcad-outgoing-preparation-connection'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { inspectSshPtyCreateOperation } from '../providers/ssh-pty-create-operation-inspection'

/** Status is an observation, not permission to replace connection evidence or resume controls. */
export async function inspectOutgoingOrcadPreparation(
  userDataPath: string,
  args: {
    identity: PtyOwnershipTransferWireIdentity
    signal: AbortSignal
    creationOperationId?: string
  }
) {
  args.signal.throwIfAborted()
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(args.identity)
  const preparations = new OrcadOutgoingPreparationStore(userDataPath)
  const connections = new OrcadOutgoingPreparationConnectionStore(userDataPath)
  const saved = preparations.read(identity)
  if (!saved) {
    throw new Error('orcad_outgoing_preparation_missing')
  }
  const connection = connections.read(identity)
  const assertEvidence = () => {
    if (
      serializeOrcadMigrationValue(preparations.read(identity)) !==
        serializeOrcadMigrationValue(saved) ||
      serializeOrcadMigrationValue(connections.read(identity)) !==
        serializeOrcadMigrationValue(connection)
    ) {
      throw new Error('orcad_outgoing_preparation_evidence_changed')
    }
  }
  return withOutgoingOrcadAuthority(
    userDataPath,
    { binding: saved, signal: args.signal, assertEvidence },
    async ({ assertAuthority }) => {
      const provider = getSshPtyProvider(saved.sourceSshTargetId)
      const generation = (provider as { providerGeneration?: number } | undefined)
        ?.providerGeneration
      const request = provider?.requestHostRpc?.bind(provider)
      if (!provider || !request || !Number.isSafeInteger(generation) || generation! <= 0) {
        throw new Error('orcad_outgoing_capture_source_unavailable')
      }
      const assertCurrent = () => {
        args.signal.throwIfAborted()
        assertAuthority()
        assertEvidence()
        if (
          getSshPtyProvider(saved.sourceSshTargetId) !== provider ||
          (provider as { providerGeneration?: number }).providerGeneration !== generation
        ) {
          throw new Error('orcad_outgoing_capture_source_authority_changed')
        }
      }
      assertCurrent()
      const capabilities = await provider.getOwnershipBridgeCapabilities?.({ signal: args.signal })
      assertCurrent()
      if (capabilities?.statusQuery !== true) {
        throw new Error('orcad_outgoing_preparation_status_unsupported')
      }
      const client = new PtyOwnershipTransferRequestClient((method, params, options) =>
        request(method, params as Record<string, unknown>, options)
      )
      const status = await client.status(
        { version: 1, ...identity },
        { signal: args.signal, timeoutMs: 5_000 }
      )
      assertCurrent()
      assertOutgoingOrcadPreparationStatusBinding(saved, status)
      if (args.creationOperationId !== undefined) {
        const creationOperation = await inspectSshPtyCreateOperation({
          provider,
          operationId: args.creationOperationId,
          signal: args.signal,
          assertCurrent
        })
        if (
          creationOperation.outcome === 'recorded' &&
          (creationOperation.terminalId !== identity.terminalId ||
            creationOperation.incarnationId !== identity.incarnationId)
        ) {
          throw new Error('orcad_outgoing_creation_identity_mismatch')
        }
        assertCurrent()
        return { ...status, creationOperation }
      }
      return status
    }
  )
}
