/**
 * The relaunch half of WSL orcad liveness: C4's deploy-and-launch on a bounded ladder, then the
 * terminal census before anything is marked. A background recovery (nothing user-visible needs
 * the distro) relaunches only into a distro confirmed running, so it can never boot one.
 */
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslOrcadConnection, WslOrcadConnectOptions } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import type { WslLivenessVerdict } from './wsl-orcad-liveness-verdict'
import type { WslOrcadReconnectBackoff } from './wsl-orcad-reconnect-backoff'

export type WslOrcadRecoveryReason = 'orcad-exited' | 'distro-restarted' | 'distro-stopped'

export type WslOrcadRecoveryContext = {
  distro: string
  backoff: WslOrcadReconnectBackoff
  now: () => number
  /** False once the distro stopped being supervised or a newer recovery took over. */
  current: () => boolean
  wait: (delayMs: number) => Promise<void>
  publish: (status: WslOrcadConnectionStatus) => void
  ensure: (options: WslOrcadConnectOptions) => Promise<WslOrcadConnection>
  collectCensus: (connection: WslOrcadConnection) => Promise<OrcadTerminalCensus>
  /** Records the new orcad's identity and holds a fresh watch. */
  arm: (connection: WslOrcadConnection) => Promise<void>
  hasUserVisibleWork: () => boolean
  readRunning: () => Promise<WslRunningDistrosRead>
}

/** Ends ready, failed, or with the verdict the background gate found instead (returned). */
export async function recoverWslOrcad(
  context: WslOrcadRecoveryContext,
  reason: WslOrcadRecoveryReason
): Promise<WslLivenessVerdict | null> {
  const terminals = reason === 'orcad-exited' ? 'unverifiable' : 'exited'
  for (;;) {
    const decision = context.backoff.next(context.now())
    if (decision.kind === 'give-up') {
      context.publish({
        state: 'failed',
        reason: `Could not restart the Orca server in ${context.distro} after ${decision.attempts} attempts`,
        terminals
      })
      return null
    }
    const reconnecting = {
      state: 'reconnecting',
      reason,
      attempt: decision.attempt,
      terminals
    } as const
    context.publish({ ...reconnecting, retryInMs: decision.delayMs })
    await context.wait(decision.delayMs)
    if (!context.current()) {
      return null
    }
    if (!context.hasUserVisibleWork()) {
      const gate = backgroundRecoveryGate(await context.readRunning(), context.distro)
      if (gate || !context.current()) {
        return gate
      }
    }
    try {
      const connection = await context.ensure({
        status: {
          pending: { ...reconnecting, retryInMs: null },
          ready: { ...reconnecting, reason: 'census', retryInMs: null }
        }
      })
      if (!context.current()) {
        return null
      }
      // Before marking anything: orcad's daemon may have kept every terminal through the crash.
      const census = await context.collectCensus(connection)
      await context.arm(connection)
      if (context.current()) {
        context.publish({ state: 'ready', census })
      }
      return null
    } catch (error) {
      console.warn(
        `[wsl] reconnect to ${context.distro} failed:`,
        error instanceof Error ? error.message : error
      )
      if (!context.current()) {
        return null
      }
    }
  }
}

/** null lets a background recovery go ahead: the distro is confirmed running. */
export function backgroundRecoveryGate(
  running: WslRunningDistrosRead,
  distro: string
): WslLivenessVerdict | null {
  if (running.status !== 'confirmed') {
    return { kind: 'unverifiable', reason: 'running-list-unavailable' }
  }
  const key = wslDistroHolderKey(distro)
  return running.distros.some((candidate) => wslDistroHolderKey(candidate) === key)
    ? null
    : { kind: 'distro-stopped', corroborated: false }
}
