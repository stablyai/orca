// Drives one Orca Cloud environment's session: renews Orca's lease while work runs, warns before the
// cap, suspends when idle, and rolls the session over (drain → stop → boot → re-pair → continue agents).
import type {
  EnvironmentHandle,
  EnvironmentProviderDriver,
  EnvironmentReady,
  EnvironmentSessionInfo
} from '../environment-providers/environment-provider-driver'
import type { HostedAgentAutoResumeOutcome } from './hosted-agent-auto-resume'
import {
  HOSTED_LEASE_POLICY,
  decideHostedLeaseAction,
  type HostedActivitySample,
  type HostedLeaseAction,
  type HostedLeaseWarning
} from './hosted-session-lease-policy'

export type HostedSessionLeasePorts = {
  driver: EnvironmentProviderDriver
  handle: EnvironmentHandle
  session: EnvironmentSessionInfo
  readActivity: () => Promise<HostedActivitySample>
  warn: (minutesLeft: HostedLeaseWarning) => void
  /** Re-pairs with the rebooted orcad; resolves once the runtime answers again. */
  reconnect: (ready: EnvironmentReady) => Promise<void>
  resumeAgents: (drainStartedAt: number) => Promise<HostedAgentAutoResumeOutcome>
  onSuspended: () => void
  /** Replaces the driver suspend, e.g. to run the window's ordinary Sleep for the workspace. */
  suspend?: () => Promise<void>
  log?: (line: string) => void
  now?: () => number
}

const UNVERIFIABLE: HostedActivitySample = {
  verdict: 'unverifiable',
  idleSince: null,
  lastPtyInputAt: null
}

export class HostedSessionLeaseScheduler {
  private session: EnvironmentSessionInfo
  private readonly warned = new Set<HostedLeaseWarning>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<HostedLeaseAction> | null = null
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
        const renewed = await this.ports.driver.renewLease?.(this.ports.handle, action.extendMs)
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
    if (!driver.rollover) {
      return
    }
    const drainStartedAt = this.now()
    this.log(`[orca-cloud] ${reason} rollover`)
    const ready = await driver.rollover(handle)
    this.session = ready.session
    this.warned.clear()
    await this.ports.reconnect(ready)
    try {
      const outcome = await this.ports.resumeAgents(drainStartedAt)
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
