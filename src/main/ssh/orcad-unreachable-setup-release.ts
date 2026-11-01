/** Release conversion setups stranded before staging by refused SSH forwarding. Stop any activated slot, unregister, then use undeployed-fence release; source rows remain intact for retry. */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './orcad-migration-source-fence'
import { closeOrcadManagedTunnel } from '../managed-server/lifecycle/orcad-managed-tunnel'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'
import { withOrcadActivationLock } from '../managed-server/activation/orcad-activation-lock'
import { withDeactivatedVersionCommitted } from '../managed-server/activation/orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record-store'
import { managedOrcadSlot } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import { orcadStopFreedTheHost } from '../managed-server/install/orcad-remote-process-control'
import { orcadSlotDir, stopOrcadSlot } from './orcad-recovery-slot'
import { sshOrcadHostTransport } from './orcad-ssh-host-transport'
import { getSshConnectionManager, getSshTargetRegistryStore } from './targets/ssh-target-registry'
import { errorMessage } from '../../shared/error-message'

export async function releaseUnreachableOrcadSetup(args: {
  userDataPath: string
  claims: SshTargetOrcadClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Staged/committed destinations require their own evidence before release.
  if (cutover?.phase !== 'source-fenced') {
    return
  }
  const environmentId = cutover.destinationEnvironmentId
  await closeOrcadManagedTunnel(environmentId).catch(() => undefined)
  await stopStrandedOrcad(args.targetId, args.signal).catch((error: unknown) => {
    console.warn(`[orcad] Could not stop the unreachable setup's server: ${errorMessage(error)}`)
  })
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  // Unregister first so an interrupted release leaves a recoverable undeployed fence.
  if (isRegistered(environmentId)) {
    removeManagedOrcadEnvironment(args.userDataPath, environmentId)
  }
  await releaseUndeployedMigrationFence({
    userDataPath: args.userDataPath,
    claims: args.claims,
    targetId: args.targetId,
    isDestinationRegistered: isRegistered,
    signal: args.signal
  })
}

/** Clear active only after proven slot exit; daemon terminals may outlive it. */
async function stopStrandedOrcad(targetId: string, signal?: AbortSignal): Promise<void> {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  const connectionManager = getSshConnectionManager()
  if (!target || !connectionManager) {
    return
  }
  const context = await resolveOrcadRemoteContext(
    target,
    sshOrcadHostTransport(await connectionManager.connect(target)),
    signal
  )
  if (!context.activationRecord.active) {
    return
  }
  // Port is irrelevant because this recovery never launches a slot.
  const slot = managedOrcadSlot(context, 0, signal)
  await withOrcadActivationLock(
    slot,
    async () => {
      const record = await readOrcadActivationRecord(slot)
      if (!record.active) {
        return
      }
      const stopped = await stopOrcadSlot(slot, orcadSlotDir(slot, record.active), false)
      if (orcadStopFreedTheHost(stopped)) {
        await writeOrcadActivationRecord(slot, withDeactivatedVersionCommitted(record))
      }
    },
    () => undefined
  )
}
