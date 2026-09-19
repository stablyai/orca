/**
 * orcad's half of the supervision contract: it spawns and supervises the terminal daemon.
 *
 * The whole reason the peer model is recommended over an SSH target is that daemon-backed
 * PTYs stay `live` across a runtime restart (docs/reference/ssh-execution-boundary.md).
 * Without a daemon here, every orcad restart, update and rollback is a SIGKILL for every
 * running terminal — on the host whose selling point is that work survives the client going
 * away.
 *
 * The constraint that makes a restart non-destructive lives in `stopOrcadDaemon` below: the
 * daemon is DETACHED and must outlive this process. Anything that tears it down on the way
 * out silently converts a restart back into data loss.
 */
import {
  disconnectDaemon,
  daemonOwnsFreshPersistentPtys,
  initDaemonPtyProvider,
  readDaemonPidRecord,
  requestIdleDaemonRetirement
} from '../daemon/daemon-init'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'

export type OrcadDaemonStartup =
  | { state: 'live'; pid: number | null }
  | { state: 'degraded'; reason: string }
  | { state: 'unavailable'; reason: string }

/**
 * Bring the daemon up and install it as the local PTY provider.
 *
 * Fail-open, like the desktop: a host that cannot start a daemon must still serve git,
 * worktrees and non-persistent terminals. What it must NOT do is keep claiming persistence
 * — `daemonOwnsFreshPersistentPtys()` is what the runtime reads for that, and it answers
 * false here without any extra bookkeeping.
 */
export async function startOrcadDaemon(
  options: { recoveryOnly?: boolean } = {}
): Promise<OrcadDaemonStartup> {
  if (options.recoveryOnly) {
    const { initDaemonRecoveryProvider } = await import('../daemon/daemon-recovery-provider-init')
    initDaemonRecoveryProvider()
    return {
      state: 'degraded',
      reason: 'managed-stop recovery; fresh terminal admission remains fenced'
    }
  }
  try {
    // Why no login-session watch: that retires the daemon when the spawning macOS GUI login
    // session dies. An orcad daemon must survive its SSH session ending — that is the point.
    await initDaemonPtyProvider(undefined, { macosLoginSessionWatch: false })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(
      `[orcad] The terminal daemon did not start: ${reason}\n` +
        '[orcad] Terminals will run in-process and WILL NOT survive an orcad restart.'
    )
    return { state: 'unavailable', reason }
  }
  if (!daemonOwnsFreshPersistentPtys()) {
    const reason = 'daemon adopted in degraded mode; fresh terminals run on the local provider'
    console.warn(
      `[orcad] ${reason}. Existing daemon sessions keep working, but new terminals will not ` +
        'survive an orcad restart until the daemon is restarted.'
    )
    return { state: 'degraded', reason }
  }
  return { state: 'live', pid: readDaemonPidRecord()?.pid ?? null }
}

/**
 * Release the daemon without killing it.
 *
 * Why `disconnectDaemon` and never `shutdownDaemon`: shutdown kills the daemon process and
 * every PTY under it. Calling it here would make orcad's own restart destructive, which is
 * the exact property this whole item exists to buy.
 */
export async function stopOrcadDaemon(): Promise<void> {
  await disconnectDaemon()
}

/** Fence all future terminal admission before allowing a managed runtime to stop. */
export type OrcadNativeDecommissionResult = OrcadDecommissionResult & {
  admissionReopened?: true
}

export async function decommissionOrcadDaemonIfIdle(): Promise<OrcadNativeDecommissionResult> {
  const result = await requestIdleDaemonRetirement()
  if (result.state === 'retiring') {
    return { outcome: 'accepted' }
  }
  if (result.state === 'busy' && result.liveSessions !== null && result.liveSessions > 0) {
    return {
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_live_sessions',
      ...(result.admissionReopened ? { admissionReopened: true as const } : {}),
      reason:
        `${result.liveSessions} terminal ` +
        `${result.liveSessions === 1 ? 'session is' : 'sessions are'} still live. ` +
        'Close the sessions before stopping and unlinking this server.'
    }
  }
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    ...(result.state === 'busy' && result.admissionReopened
      ? { admissionReopened: true as const }
      : {}),
    code:
      result.state === 'unsupported'
        ? 'orcad_decommission_daemon_incompatible'
        : 'orcad_decommission_unverifiable',
    reason:
      result.state === 'unsupported'
        ? 'The terminal daemon is from an older generation that cannot be atomically decommissioned.'
        : 'The host could not atomically prove that terminal admission is fenced and no sessions are live.'
  }
}
