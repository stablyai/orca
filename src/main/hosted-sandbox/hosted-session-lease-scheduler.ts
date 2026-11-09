// Drives one Orca Cloud environment's session: renews Orca's lease while work runs, warns before the
// cap, suspends when idle, and rolls the session over (drain → stop → boot → re-pair → continue agents).
import type { EnvironmentHandle } from '../environment-providers/environment-provider-driver'
import type {
  HostedEnvironmentProviderDriver,
  HostedEnvironmentReady,
  HostedSessionInfo
} from './hosted-environment-provider'
import type { HostedAgentAutoResumeOutcome } from './hosted-agent-auto-resume'
import type { HostedSessionStateEvent } from '../../shared/hosted-sandbox/hosted-session-events'
import {
  HOSTED_LEASE_POLICY,
  decideHostedLeaseAction,
  type HostedActivitySample,
  type HostedLeaseAction,
  type HostedLeaseWarning
} from './hosted-session-lease-policy'

export type HostedSessionLeasePorts = {
  driver: HostedEnvironmentProviderDriver
  handle: EnvironmentHandle
  session: HostedSessionInfo
  readActivity: () => Promise<HostedActivitySample>
  warn: (minutesLeft: HostedLeaseWarning) => void
  /** Re-pairs with the rebooted orcad; resolves once the runtime answers again. */
  reconnect: (ready: HostedEnvironmentReady) => Promise<void>
  resumeAgents: (
    drainStartedAt: number,
    offersBeforeDrain: ReadonlySet<string> | null
  ) => Promise<HostedAgentAutoResumeOutcome>
  /** The host's restart offers before the drain, so only the drain's own are continued. */
  snapshotOffers?: () => Promise<ReadonlySet<string> | null>
  onSuspended: () => void
  /** Replaces the driver suspend, e.g. to run the window's ordinary Sleep for the workspace. */
  suspend?: () => Promise<void>
  /** A rollover started (`restarting`), its new session is back (`running`), or it failed. */
  onRolloverStateChange?: (state: HostedSessionStateEvent['state']) => void
  log?: (line: string) => void
  now?: () => number
}

const UNVERIFIABLE: HostedActivitySample = {
  verdict: 'unverifiable',
  idleSince: null,
  lastPtyInputAt: null
}

export class HostedSessionLeaseScheduler {
  private session: HostedSessionInfo
  private readonly warned = new Set<HostedLeaseWarning>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<HostedLeaseAction> | null = null
  private restarting: Promise<boolean> | null = null
  private stopped = false
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly ports: HostedSessionLeasePorts) {
    this.session = ports.session
    this.now = ports.now ?? Date.now
    this.log = ports.log ?? (() => {})
  }

  start(pollMs = 30_000): void {
    this.stopped = false
    this.schedule(pollMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One decision + action; concurrent calls share the in-flight one. */
  tick(): Promise<HostedLeaseAction> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** "Restart now": the forced rollover, run in turn with any in-flight tick. False if it cannot roll over. */
  restartNow(): Promise<boolean> {
    // Two windows asking at once share one restart.
    this.restarting ??= this.runRestartNow().finally(() => {
      this.restarting = null
    })
    return this.restarting
  }

  private async runRestartNow(): Promise<boolean> {
    if (this.stopped || !this.ports.driver.rollover) {
      return false
    }
    const sessionBefore = this.session
    while (this.running) {
      await this.running.catch(() => undefined)
    }
    // The tick it waited on may have slept the workspace or already rolled the session over.
    if (this.stopped) {
      return false
    }
    if (this.session !== sessionBefore) {
      return true
    }
    const restart = this.rollover('forced').then((): HostedLeaseAction => ({
      kind: 'rollover',
      reason: 'forced'
    }))
    this.running = restart
      .catch((): HostedLeaseAction => ({ kind: 'none' }))
      .finally(() => {
        this.running = null
      })
    await restart
    return true
  }

  private async runOnce(): Promise<HostedLeaseAction> {
    const activity = await this.ports.readActivity().catch(() => UNVERIFIABLE)
    const action = decideHostedLeaseAction({
      now: this.now(),
      capabilities: this.ports.driver.capabilities,
      session: this.session,
      activity,
      warned: this.warned
    })
    switch (action.kind) {
      case 'renew': {
        const renewed = await this.ports.driver.renewLease(this.ports.handle, action.extendMs)
        if (renewed?.session) {
          this.session = renewed.session
        }
        break
      }
      case 'warn':
        // A later, shorter warning supersedes every longer one still pending.
        for (const warning of HOSTED_LEASE_POLICY.warnings) {
          if (warning >= action.minutesLeft) {
            this.warned.add(warning)
          }
        }
        this.ports.warn(action.minutesLeft)
        break
      case 'idle-suspend':
        await (this.ports.suspend
          ? this.ports.suspend()
          : this.ports.driver.suspend(this.ports.handle))
        this.stop()
        this.ports.onSuspended()
        break
      case 'rollover':
        await this.rollover(action.reason)
        break
      case 'none':
        break
    }
    return action
  }

  private async rollover(reason: 'opportunistic' | 'forced'): Promise<void> {
    const { driver, handle } = this.ports
    const offersBeforeDrain = (await this.ports.snapshotOffers?.().catch(() => null)) ?? null
    const drainStartedAt = this.now()
    this.log(`[orca-cloud] ${reason} rollover`)
    this.ports.onRolloverStateChange?.('restarting')
    try {
      const ready = await driver.rollover(handle)
      this.session = ready.session
      this.warned.clear()
      await this.ports.reconnect(ready)
    } catch (error) {
      this.ports.onRolloverStateChange?.('restart-failed')
      throw error
    }
    this.ports.onRolloverStateChange?.('running')
    try {
      const outcome = await this.ports.resumeAgents(drainStartedAt, offersBeforeDrain)
      this.log(
        `[orca-cloud] continued ${outcome.continued}/${outcome.offered} agents after rollover`
      )
    } catch (error) {
      // The offers stay on the host, so the ordinary resume prompt still covers them.
      this.log(`[orca-cloud] agent auto-resume failed: ${String(error)}`)
    }
  }

  private schedule(pollMs: number): void {
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
        .catch((error: unknown) => this.log(`[orca-cloud] lease tick failed: ${String(error)}`))
        .finally(() => this.schedule(pollMs))
    }, pollMs)
    this.timer.unref?.()
  }
}
