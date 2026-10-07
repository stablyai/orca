/**
 * Recovers a host an earlier build stranded: a conversion fenced it and registered its managed
 * server, but the host's sshd refuses the forward that server is reached by, so nothing was ever
 * staged there. The source still holds every row, so the server is unregistered and the fence
 * released through the undeployed-fence path, and the relay serves the host again. An orcad the
 * setup did activate is stopped first, so a later conversion starts fresh rather than deferring.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './orcad-migration-source-fence'
import { closeOrcadManagedTunnel } from './orcad-managed-tunnel'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { withOrcadActivationLock } from './orcad-activation-lock'
import { withDeactivatedVersion } from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { orcadSlotDir, stopOrcadSlot } from './orcad-recovery-slot'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'
import { errorMessage } from '../../shared/error-message'

export async function releaseUnreachableOrcadSetup(args: {
  userDataPath: string
  claims: SshTargetOrcadClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Why only this phase: a staged or committed destination holds state only it can account for.
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
  // Unregister first: a crash after it leaves an undeployed fence, which the same path releases.
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

/** Clears `active` only once the slot is proven exited; its daemon and terminals outlive it. */
async function stopStrandedOrcad(targetId: string, signal?: AbortSignal): Promise<void> {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  const connectionManager = getSshConnectionManager()
  if (!target || !connectionManager) {
    return
  }
  const context = await resolveOrcadRemoteContext(
    target,
    await connectionManager.connect(target),
    signal
  )
  if (!context.activationRecord.active) {
    return
  }
  // The port only matters for a launch, which this never does.
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
        await writeOrcadActivationRecord(slot, withDeactivatedVersion(record))
      }
    },
    () => undefined
  )
}
