import { encodePairingOffer } from '../../shared/pairing'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { runtimeEnvironmentSshAccessBinding } from '../../shared/runtime-environment-ssh-access-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { requireManagedOrcadTargetStore } from './orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-access'
import { parseOrcadOutgoingTargetBinding } from './orcad-outgoing-capture-store'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { retainOrcadLiveProfileParticipation } from './orcad-live-profile-participation'
import { retainOrcadLiveSuccessorProfileAuthority } from './orcad-live-successor-profile-authority'

type OutgoingAuthorityArgs = {
  binding: unknown
  signal: AbortSignal
  assertEvidence: () => void
  sourceCutoverMigrationId?: string
}
type OutgoingAuthorityContext = {
  pairingCode: string
  assertAuthority: () => void
  assertSourceCutoverOwner: (owner: 'unowned' | 'fenced') => void
}

export function withOutgoingOrcadAuthority<T>(
  userDataPath: string,
  args: OutgoingAuthorityArgs,
  operation: (context: OutgoingAuthorityContext) => Promise<T>
): Promise<T> {
  return withOutgoingAuthority(userDataPath, args, operation, 'original')
}

/** Separate admission: native exclusion never substitutes for ordinary same-process ownership. */
export function withOutgoingOrcadSuccessorAuthority<T>(
  userDataPath: string,
  args: OutgoingAuthorityArgs & { sourceCutoverMigrationId: string },
  operation: (context: OutgoingAuthorityContext) => Promise<T>
): Promise<T> {
  return withOutgoingAuthority(userDataPath, args, operation, 'successor')
}

async function withOutgoingAuthority<T>(
  userDataPath: string,
  args: OutgoingAuthorityArgs,
  operation: (context: OutgoingAuthorityContext) => Promise<T>,
  admission: 'original' | 'successor'
): Promise<T> {
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  args.signal.throwIfAborted()
  const saved = parseOrcadOutgoingTargetBinding(args.binding)
  return runTargetLifecycle(
    `runtime-ssh-access:${userDataPath}:${saved.destinationEnvironmentId}`,
    () =>
      runTargetLifecycle(saved.sourceSshTargetId, async () => {
        const targetStore = requireManagedOrcadTargetStore()
        const originalTarget = targetStore.getTarget(saved.sourceSshTargetId)
        if (!originalTarget || originalTarget.generation !== saved.sourceSshTargetGeneration) {
          throw new Error('orcad_outgoing_capture_target_changed')
        }
        const targetFingerprint = fingerprintRuntimeSshTarget(originalTarget)
        let targetOwner = serializeOrcadMigrationValue(originalTarget.owner ?? null)
        const environment = resolveEnvironment(userDataPath, saved.destinationEnvironmentId)
        const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
        const environmentFence = (current: typeof environment) =>
          serializeOrcadMigrationValue(runtimeEnvironmentSshAccessBinding(current))
        const expectedEnvironment = environmentFence(environment)
        let assertParticipation: (() => void) | undefined
        const assertAuthorityForOwner = (expectedOwner: string) => {
          args.signal.throwIfAborted()
          if (admission === 'successor' && !args.sourceCutoverMigrationId) {
            throw new Error('orcad_live_successor_migration_required')
          }
          if (!assertParticipation && args.sourceCutoverMigrationId) {
            const intent = new OrcadLiveCutoverIntentStore(userDataPath).read(saved.identity)
            if (!intent && admission === 'successor') {
              throw new Error('orcad_live_successor_intent_required')
            }
            if (intent) {
              if (intent.manifest.migrationId !== args.sourceCutoverMigrationId) {
                throw new Error('orcad_live_participation_intent_changed')
              }
              assertParticipation =
                admission === 'successor'
                  ? retainOrcadLiveSuccessorProfileAuthority(userDataPath, intent)
                  : retainOrcadLiveProfileParticipation(userDataPath, intent)
            }
          }
          assertParticipation?.()
          const currentTarget = targetStore.getTarget(saved.sourceSshTargetId)
          const current = resolveEnvironment(userDataPath, saved.destinationEnvironmentId)
          if (
            !isPtyOwnershipTransferMutationEnabled() ||
            !currentTarget ||
            currentTarget.generation !== saved.sourceSshTargetGeneration ||
            currentTarget.orcadProvisioning ||
            fingerprintRuntimeSshTarget(currentTarget) !== targetFingerprint ||
            serializeOrcadMigrationValue(currentTarget.owner ?? null) !== expectedOwner ||
            current.runtimeId !== saved.identity.destinationRuntimeId ||
            current.pendingSshAccessOperation ||
            environmentFence(current) !== expectedEnvironment
          ) {
            throw new Error('orcad_outgoing_capture_authority_changed')
          }
          args.assertEvidence()
        }
        const assertAuthority = () => assertAuthorityForOwner(targetOwner)
        const assertSourceCutoverOwner = (owner: 'unowned' | 'fenced') => {
          if (!args.sourceCutoverMigrationId) {
            throw new Error('orcad_live_cutover_owner_transition_not_enabled')
          }
          const expectedOwner = serializeOrcadMigrationValue(
            owner === 'unowned' ? null : createManagedOrcadSshOwner(environment.id)
          )
          if (owner === 'unowned' && targetOwner !== expectedOwner) {
            throw new Error('orcad_live_cutover_owner_transition_conflict')
          }
          if (
            owner === 'fenced' &&
            targetOwner !== serializeOrcadMigrationValue(null) &&
            targetOwner !== expectedOwner
          ) {
            throw new Error('orcad_live_cutover_owner_transition_conflict')
          }
          assertAuthorityForOwner(expectedOwner)
          if (owner === 'fenced') {
            const migrationStore = targetStore.getOrcadMigrationStore()
            const candidate = inspectOrcadLiveCutoverRecovery(userDataPath, {
              getSshTarget: (id) => targetStore.getTarget(id),
              listOrcadMigrationSourceCutovers: () =>
                migrationStore.listOrcadMigrationSourceCutovers()
            }).find((entry) => entry.intent.manifest.migrationId === args.sourceCutoverMigrationId)
            if (
              !candidate?.journal ||
              candidate.intent.destinationEnvironmentId !== environment.id ||
              candidate.intent.manifest.source.sshTargetId !== saved.sourceSshTargetId ||
              candidate.intent.manifest.source.sshTargetGeneration !==
                saved.sourceSshTargetGeneration ||
              !candidate.intent.liveTerminalBindings?.some((entry) =>
                samePtyOwnershipTransferIdentity(entry.identity, saved.identity)
              )
            ) {
              throw new Error('orcad_live_cutover_owner_transition_conflict')
            }
          }
          targetOwner = expectedOwner
        }
        assertAuthority()
        await ensureOrcadManagedTunnel(userDataPath, environment.id)
        assertAuthority()
        return operation({ pairingCode, assertAuthority, assertSourceCutoverOwner })
      })
  )
}
