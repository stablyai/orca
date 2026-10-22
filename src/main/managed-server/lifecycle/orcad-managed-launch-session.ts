/**
 * Whether a managed orcad on a macOS host outlived the SSH session that started it (#25934), and
 * the restart that re-attributes it to the current session. See orcad-launch-ssh-session.ts.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadManagedRestartResult } from '../../../shared/orcad-managed-runtime'
import {
  withOrcadActivationLock,
  type OrcadActivationLockControl
} from '../activation/orcad-activation-lock'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import {
  orcadLaunchSshSessionProbeCommand,
  parseOrcadLaunchSshSession,
  recordsOrcadLaunchSshSession,
  type OrcadLaunchSshSession
} from '../../ssh/orcad-launch-ssh-session'
import { withManagedOrcadLifecycle } from '../../ssh/orcad-runtime-maintenance'
import {
  managedOrcadInstallDir,
  managedOrcadSlot,
  requireManagedOrcadEnvironment,
  requireManagedOrcadInfrastructure,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'
import { sshOrcadHostTransport } from '../../ssh/orcad-ssh-host-transport'
import { rebuildOrcadManagedTunnel } from './orcad-managed-tunnel'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { readRemoteOrcadManagedStopTarget } from './orcad-managed-remote-stop'
import { orcadSlotDir, type OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import { stopIncumbentBehindTerminalBarrier } from './orcad-rollback-terminal-barrier'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { collectManagedTerminalCensus } from '../../ssh/orcad-terminal-census-client'
import { runFencedStop, updateTerminalCounts } from '../../ssh/orcad-fenced-stop'

export async function readManagedOrcadLaunchSshSession(
  userDataPath: string,
  environmentId: string
): Promise<OrcadLaunchSshSession> {
  const { deployment } = requireManagedOrcadEnvironment(userDataPath, environmentId)
  const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  // Why the open connection only: a background check must never redial a host the user left.
  const connection =
    target && connectionManager.getState(target.id)?.status === 'connected'
      ? (connectionManager.getConnection(target.id) ?? null)
      : null
  if (!target || !connection) {
    return 'unverifiable'
  }
  const context = await resolveOrcadRemoteContext(target, sshOrcadHostTransport(connection))
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

/**
 * Stops the active slot, retiring its idle terminal daemon, and starts it again from this
 * client's SSH session. Only on a host with no terminals: a surviving daemon keeps the old
 * attribution for every terminal it spawns.
 */
export function restartManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): Promise<OrcadManagedRestartResult> {
  return withManagedOrcadLifecycle(userDataPath, selector, async ({ environment, deployment }) => {
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
    // Unfenced: a host with terminals is refused before anything waits on its lock.
    const census = await counts.countFirst()
    if (census.liveSessions !== 0) {
      return { outcome: 'terminals-running', liveSessions: census.liveSessions }
    }
    const slot = managedOrcadSlot(context, deployment.remotePort)
    const stopped = await withOrcadActivationLock(
      slot,
      (lock) => recountThenStop(slot, lock, counts),
      (): StopOutcome => ({
        state: 'kept',
        reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
      })
    )
    if (stopped.state === 'terminals-running') {
      return { outcome: 'terminals-running', liveSessions: stopped.liveSessions }
    }
    if (stopped.state === 'kept') {
      return { outcome: 'not-restarted', reason: stopped.reason }
    }
    // Started even when the daemon stayed: a stopped server serves nothing.
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
    // The started server may have bound another port than the forward in use.
    await rebuildOrcadManagedTunnel(userDataPath, environment.id)
    const dir = orcadSlotDir(slot, stopped.version)
    if (stopped.state === 'daemon-kept') {
      // The launch carried the ended session forward, so later connects keep the warning.
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
  })
}

type StopOutcome =
  | { state: 'retired'; version: string }
  /** orcad exited but its daemon, which spawns every terminal, kept the old attribution. */
  | { state: 'daemon-kept'; version: string; reason: string }
  /** orcad keeps serving, or may still be stopping: nothing is started. */
  | { state: 'kept'; reason: string; mayBeStopping?: true }
  /** The fenced recount under the lock found terminals: nothing was stopped. */
  | { state: 'terminals-running'; liveSessions: number | null }

/**
 * Under the host lock, like an update's last count: only the lock holder closes or reopens the
 * server's terminal admission, so a restart that loses the lock never clears another's fence.
 */
async function recountThenStop(
  slot: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  counts: ReturnType<typeof updateTerminalCounts>
): Promise<StopOutcome> {
  const fenced = await runFencedStop({
    ...counts,
    now: Date.now,
    refuse: (census): StopOutcome | null =>
      census.liveSessions === 0
        ? null
        : { state: 'terminals-running', liveSessions: census.liveSessions },
    stale: (): StopOutcome => STALE_COUNT,
    stop: (stillFenced) => stopRetiringIdleDaemon(slot, lock, stillFenced),
    // A woken server starts with admission open, so only an unsent stop needs a reopen.
    stopMayHaveBeenSent: (outcome) =>
      outcome.state === 'retired' ||
      outcome.state === 'daemon-kept' ||
      (outcome.state === 'kept' && outcome.mayBeStopping === true)
  })
  return 'refused' in fenced ? fenced.refused : fenced.stopped
}

const STALE_COUNT: StopOutcome = {
  state: 'kept',
  reason: 'The terminal count went stale before the stop. Restart again.'
}

/** The rollback's managed stop: orcad retires its daemon only when no session exists then. */
async function stopRetiringIdleDaemon(
  slot: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  stillFenced: () => boolean
): Promise<StopOutcome> {
  // Re-read under the fence: another client may have changed the active slot.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active) {
    return { state: 'kept', reason: 'This host has no activated Orca server.' }
  }
  const target = await readRemoteOrcadManagedStopTarget(slot, active)
  if (target.state === 'refused') {
    return { state: 'kept', reason: target.reason }
  }
  // The census's fence lapses on its own; a stop after that could kill a terminal admitted since.
  if (!stillFenced()) {
    return STALE_COUNT
  }
  const barrier = await stopIncumbentBehindTerminalBarrier(slot, randomUUID(), target.context)
  switch (barrier.state) {
    case 'retired':
      return { state: 'retired', version: active }
    case 'unproven':
      return {
        state: 'daemon-kept',
        version: active,
        reason:
          'This host’s Orca server restarted, but its terminal daemon kept running because a terminal ' +
          'was open at the stop, so terminals may still lack local network access.'
      }
    case 'unsettled':
      // orcad may still be stopping; like the rollback, the fence stays until recovery drops it.
      lock.retain()
      return { state: 'kept', reason: barrier.reason, mayBeStopping: true }
    case 'withdrawn':
      return { state: 'kept', reason: barrier.reason }
  }
}
