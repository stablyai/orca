import type { OrcadManagedRestartResult } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import {
  orcadLaunchSshSessionProbeCommand,
  parseOrcadLaunchSshSession,
  recordsOrcadLaunchSshSession,
  type OrcadLaunchSshSession
} from '../install/orcad-launch-ssh-session'
import { withManagedOrcadLifecycle } from './orcad-managed-lifecycle'
import {
  managedOrcadInstallDir,
  managedOrcadSlot,
  requireManagedOrcadEnvironment,
  requireManagedOrcadInfrastructure,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'

import { rebuildOrcadManagedTunnel } from './orcad-managed-tunnel'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { orcadSlotDir } from '../activation/orcad-recovery-slot'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { updateTerminalCounts } from '../activation/orcad-fenced-stop'
import { stopIdleOrcadForRestart } from './orcad-idle-restart-stop'

export async function readManagedOrcadLaunchSshSession(
  userDataPath: string,
  environmentId: string
): Promise<OrcadLaunchSshSession> {
  const { deployment } = await requireManagedOrcadEnvironment(userDataPath, environmentId)
  const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  // Background checks must not reconnect hosts the user left.
  const connection =
    target && connectionManager.getState(target.id)?.status === 'connected'
      ? (connectionManager.getConnection(target.id) ?? null)
      : null
  if (!target || !connection) {
    return 'unverifiable'
  }
  const context = await resolveOrcadRemoteContext(target, connection)
  if (!recordsOrcadLaunchSshSession(context.host)) {
    return 'not-applicable'
  }
  const active = context.activationRecord.active
  if (!active) {
    return 'not-recorded'
  }
  return parseOrcadLaunchSshSession(
    await execOrcadRemote(
      { conn: context.connection, host: context.host },
      orcadLaunchSshSessionProbeCommand(
        context.host,
        managedOrcadInstallDir(context, active),
        context.userDataDir
      )
    )
  )
}

/** Restart only without terminals: surviving daemons retain the old SSH-session attribution. */
export async function restartManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): Promise<OrcadManagedRestartResult> {
  return await withManagedOrcadLifecycle(
    userDataPath,
    selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment)
      if (!context.activationRecord.active) {
        return { outcome: 'not-restarted', reason: 'This host has no activated Orca server.' }
      }
      const counts = updateTerminalCounts((options) =>
        collectManagedTerminalCensus(
          userDataPath,
          environment,
          context.activationRecord,
          undefined,
          options
        )
      )
      // Reject live terminals before waiting for the host lock.
      const census = await counts.countFirst()
      if (census.liveSessions !== 0) {
        return { outcome: 'terminals-running', liveSessions: census.liveSessions }
      }
      const slot = managedOrcadSlot(context, deployment.remotePort)
      const stopped = await stopIdleOrcadForRestart(slot, counts)
      if (stopped.state === 'terminals-running') {
        return { outcome: 'terminals-running', liveSessions: stopped.liveSessions }
      }
      if (stopped.state === 'kept') {
        return { outcome: 'not-restarted', reason: stopped.reason }
      }
      // Wake even when daemon retirement failed: the stopped server cannot serve clients.
      const wake = await wakeStoppedManagedOrcad(slot)
      if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
        return {
          outcome: 'not-restarted',
          reason:
            wake.outcome === 'recovery-refused'
              ? wake.reason
              : `This host’s Orca server stopped but did not start again (${wake.outcome}); reconnect to start it.`
        }
      }
      // Restart may bind a different port than the existing forward.
      await rebuildOrcadManagedTunnel(userDataPath, environment.id)
      const dir = orcadSlotDir(slot, stopped.version)
      if (stopped.state === 'daemon-kept') {
        // A retained daemon keeps old attribution, so preserve the warning.
        return { outcome: 'not-restarted', reason: stopped.reason }
      }
      const session = parseOrcadLaunchSshSession(
        await execOrcadRemote(
          slot,
          orcadLaunchSshSessionProbeCommand(slot.host, dir, slot.userDataDir)
        )
      )
      if (session === 'exited') {
        return {
          outcome: 'not-restarted',
          reason:
            'This host’s Orca server restarted, but its terminals still belong to an SSH session ' +
            'that has ended: its terminal daemon was still running, or this connection opens a ' +
            'new SSH session for each command. Turn on SSH connection reuse for this host if ' +
            'it is off, then restart again.'
        }
      }
      return { outcome: 'restarted', environmentId: environment.id }
    }
  )
}
