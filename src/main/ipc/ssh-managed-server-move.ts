/**
 * The user's "Move to managed server": stop the host's relay terminals, then reconnect so the
 * connect-time decision proves them exited with its own census and runs the conversion.
 */
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import type { SshManagedServerMoveResult } from '../../shared/ssh-managed-server-move'
import type {
  SshManagedServerStatus,
  SshTarget,
  SshTerminateSessionsResult
} from '../../shared/ssh-types'
import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import {
  trackSshHostServerMove,
  type SshHostServerMoveOutcome
} from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectTarget } from './ssh-connect-flow'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { terminateSshTargetSessions } from './ssh-terminate-sessions'

export type SshManagedServerMoveDeps = {
  getTarget: (targetId: string) => SshTarget | undefined
  /** Stops the relay terminals as main's own restart, reporting each shell it stopped. */
  terminate: (
    targetId: string,
    onStopped: (appPtyId: string) => void
  ) => Promise<SshTerminateSessionsResult>
  connect: (targetId: string) => Promise<unknown>
  serverStatus: (targetId: string) => SshManagedServerStatus | undefined
  report: (targetId: string, outcome: SshHostServerMoveOutcome) => void
  /** Detaches a relay session a failed stop left up, keeping its terminals' leases. */
  releaseRelay: (targetId: string) => Promise<void>
}

export async function moveSshHostToManagedServer(
  targetId: string,
  deps: SshManagedServerMoveDeps = defaultMoveDeps()
): Promise<SshManagedServerMoveResult> {
  let result: SshManagedServerMoveResult | null = null
  try {
    result = await moveHost(targetId, deps)
    return result
  } finally {
    deps.report(targetId, moveOutcome(result))
  }
}

function moveOutcome(result: SshManagedServerMoveResult | null): SshHostServerMoveOutcome {
  if (!result) {
    return 'failed'
  }
  return result.outcome === 'refused' ? `refused_${result.verdict}` : result.outcome
}

async function moveHost(
  targetId: string,
  deps: SshManagedServerMoveDeps
): Promise<SshManagedServerMoveResult> {
  if (!deps.getTarget(targetId)) {
    throw new Error(`SSH target "${targetId}" not found`)
  }
  // Why the reconnect's census decides, not the stop: a stop can fail after its shells died (a
  // relay that hung up on its last exit), and the connect's decision runs the census the
  // conversion trusts, while that connect holds the raw transport's 'connected'.
  const stoppedPtyIds = new Set<string>()
  const stopped = await stopRelayTerminals(targetId, deps, (appPtyId) =>
    stoppedPtyIds.add(appPtyId)
  ).catch((error: unknown) => {
    console.warn('[ssh] Stopping relay terminals for the move failed; asking the census:', error)
    return null
  })
  if (!stopped) {
    // The failed stop left the relay up; a live session would make the reconnect a no-op refresh.
    await deps.releaseRelay(targetId)
  }
  const status = await deps.connect(targetId).then(
    () => deps.serverStatus(targetId),
    (error: unknown) => {
      console.warn('[ssh] Reconnecting for the move failed:', error)
      return undefined
    }
  )
  if (status?.kind === 'managed') {
    return { outcome: 'moved', environmentId: status.environmentId }
  }
  const restart = stoppedPtyIds.size > 0 ? { stoppedPtyIds: [...stoppedPtyIds] } : {}
  // Why: an unreached shell is never evidence that it exited (ssh-execution-boundary.md).
  if (stopped && stopped.unverifiable > 0) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: stopped.unverifiable,
      ...restart
    }
  }
  if (status?.kind === 'relay' && status.reason === 'relay_terminals_live') {
    return { outcome: 'refused', verdict: 'live', terminals: status.terminals ?? 0, ...restart }
  }
  if (status?.kind === 'relay' && status.reason === 'relay_terminals_unverifiable') {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: status.terminals ?? 0,
      ...restart
    }
  }
  return { outcome: 'stayed', ...restart }
}

/** Mirrors the renderer's terminate: preserved shells need a fresh relay before they can be stopped. */
async function stopRelayTerminals(
  targetId: string,
  deps: SshManagedServerMoveDeps,
  onStopped: (appPtyId: string) => void
): Promise<SshTerminateSessionsResult> {
  try {
    return await deps.terminate(targetId, onStopped)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      throw error
    }
    await deps.connect(targetId)
    return deps.terminate(targetId, onStopped)
  }
}

function defaultMoveDeps(): SshManagedServerMoveDeps {
  return {
    getTarget: (targetId) => getSshTargetRegistryStore()!.getTarget(targetId),
    // Why 'replaced': the move restarts these terminals, so main and every viewer keep their tabs.
    terminate: (targetId, onStopped) =>
      terminateSshTargetSessions(targetId, { intentionalStop: 'replaced', onStopped }),
    connect: connectTarget,
    serverStatus: getSshHostServerStatus,
    report: (targetId, outcome) => trackSshHostServerMove(outcome, knownSshHostPlatform(targetId)),
    releaseRelay: (targetId) =>
      runTargetLifecycle(targetId, () =>
        teardownSshTargetTransport(targetId, (session) => session.detachAndPersist())
      )
  }
}
