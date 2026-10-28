/** D2c/C6 classify watch exits against fresh running lists and guest incarnation, publishing through onChange. Boot only for visible demand; background work waits for running evidence. Use monotonic timers and reverify after resume. */
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import type { WslOrcadConnectIntent, WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { recoverWslOrcad, type WslOrcadRecoveryReason } from './wsl-orcad-liveness-recovery'
import {
  confirmsRunning,
  EXIT_SETTLE_MS,
  gatherWslLivenessEvidence
} from './wsl-orcad-liveness-evidence'
import {
  attachSupervisedWatch,
  cancellableWait,
  defaultSchedule,
  ensureHolderQuietly,
  probeOrcadPort,
  scheduleSupervisedHeartbeat,
  subscribeWake
} from './wsl-orcad-liveness-monitor'
import {
  disarmSupervised,
  isSupervisedSettling,
  isWatchOrHolderExit,
  noteSupervisedExit,
  newSupervised,
  WSL_ORCAD_HEARTBEAT_MS,
  type Supervised,
  type Trigger,
  type WslOrcadLivenessDependencies,
  type WslOrcadTimer
} from './wsl-orcad-liveness-state'
import {
  classifyWslOrcadLiveness,
  type WslLivenessEvidence,
  type WslLivenessVerdict
} from './wsl-orcad-liveness-verdict'
import { WslOrcadReconnectBackoff, wslOrcadVerifyRetryDelayMs } from './wsl-orcad-reconnect-backoff'

const VERIFY: Trigger = { source: 'verify' }

export class WslOrcadLivenessSupervisor {
  private readonly supervised = new Map<string, Supervised>()
  private readonly now: () => number
  private readonly schedule: (delayMs: number, task: () => void) => WslOrcadTimer
  private readonly heartbeatMs: number
  private readonly unsubscribePower: () => void
  private suspended = false

  constructor(private readonly deps: WslOrcadLivenessDependencies) {
    this.now = deps.monotonicNow ?? (() => performance.now())
    this.schedule = deps.schedule ?? defaultSchedule
    this.heartbeatMs = deps.heartbeatMs ?? WSL_ORCAD_HEARTBEAT_MS
    this.unsubscribePower = subscribeWake(deps.subscribePower, (suspended) => {
      this.suspended = suspended
      if (!suspended) {
        for (const entry of this.supervised.values()) {
          this.trigger(entry, { source: 'verify' })
        }
      }
    })
  }

  /** User-initiated, so it may boot the distro. Resolves once the watch is armed. */
  async connect(distro: string, options: WslOrcadConnectIntent = {}): Promise<WslOrcadConnection> {
    const entry = this.entryFor(distro)
    // Clear prior failures even if the bridge offer is unchanged.
    const reportReady = entry.busy || (entry.state !== null && entry.state !== 'ready')
    // Explicit connect supersedes pending recovery/rechecks and owns rearming.
    const generation = (entry.generation += 1)
    disarmSupervised(entry)
    let connection: WslOrcadConnection
    try {
      connection = await this.deps.manager.ensure(entry.distro, options)
    } catch (error) {
      // Rejected updates may leave the incumbent serving; keep it watched.
      const incumbent = this.deps.manager.get(entry.distro)
      if (error instanceof WslDistroNotRunningError && entry.generation === generation) {
        // Arming would dial into the distro; liveness, not the refused poll, gives the verdict.
        this.trigger(entry, { source: 'verify' })
      } else if (incumbent && entry.generation === generation) {
        await this.arm(entry, incumbent)
      }
      throw error
    }
    if (entry.generation === generation) {
      entry.backoff.reset()
      await this.arm(entry, connection)
      if (reportReady && entry.generation === generation) {
        this.publish(entry, { state: 'ready', census: null })
      }
    }
    return connection
  }

  noteHolderExit(distro: string, exit: { code: number | null }): void {
    const entry = this.supervised.get(wslDistroHolderKey(distro))
    if (entry) {
      this.trigger(entry, { source: 'holder', code: exit.code })
    }
  }

  async stop(distro: string): Promise<void> {
    const key = wslDistroHolderKey(distro)
    const entry = this.supervised.get(key)
    if (entry) {
      entry.generation += 1
      disarmSupervised(entry)
      this.supervised.delete(key)
    }
    await this.deps.manager.close(distro)
  }

  async dispose(): Promise<void> {
    this.unsubscribePower()
    await Promise.all([...this.supervised.values()].map((entry) => this.stop(entry.distro)))
  }

  /** E9: a poll must wait for this distro's verdict rather than reconnect (see the helper). */
  isSettling(distro: string): boolean {
    return isSupervisedSettling(this.supervised.get(wslDistroHolderKey(distro)), this.now())
  }

  private entryFor(distro: string): Supervised {
    const key = wslDistroHolderKey(distro)
    const existing = this.supervised.get(key)
    if (existing) {
      return existing
    }
    const backoff = new WslOrcadReconnectBackoff(this.deps.random)
    const entry = newSupervised(distro, key, this.now(), backoff)
    this.supervised.set(key, entry)
    return entry
  }

  private publish(entry: Supervised, status: WslOrcadConnectionStatus): void {
    entry.state = status.state
    this.deps.manager.publish(entry.distro, status)
  }

  /** Records who this orcad is and holds the watch; that identity anchors every later verdict. */
  private async arm(entry: Supervised, connection: WslOrcadConnection): Promise<void> {
    const generation = entry.generation
    const identity = await this.deps.readIdentity(entry.distro, connection.pid)
    if (entry.generation !== generation) {
      return
    }
    entry.expected = {
      distroInstance: identity?.distroInstance ?? null,
      orcad: identity?.orcad ?? null
    }
    entry.state = 'ready'
    entry.verifyStreak = 0
    entry.backoff.noteReady(this.now())
    if (!entry.watch && (await this.attachWatch(entry, connection)) !== 'ready') {
      if (entry.generation === generation) {
        this.scheduleVerify(entry)
      }
      return
    }
    // A holder that took the previous orcad's idle release just before this launch is gone now.
    await ensureHolderQuietly(this.deps.ensureHolder, entry.distro)
    // Do not overwrite the timer owned by a superseding connect.
    if (entry.generation === generation) {
      this.scheduleHeartbeat(entry)
    }
  }

  private attachWatch(entry: Supervised, connection: WslOrcadConnection) {
    return attachSupervisedWatch(
      entry,
      () => this.deps.openWatch(connection),
      (code) => this.trigger(entry, { source: 'bridge', code }),
      // Nothing proves orcad now: bring the next full check forward to the idle period.
      () => this.scheduleHeartbeat(entry)
    )
  }

  private scheduleHeartbeat(entry: Supervised): void {
    scheduleSupervisedHeartbeat(entry, this.schedule, this.now, this.heartbeatMs, (trigger) =>
      this.trigger(entry, trigger)
    )
  }

  private scheduleVerify(entry: Supervised): void {
    entry.timer?.cancel()
    const delayMs = wslOrcadVerifyRetryDelayMs(entry.verifyStreak)
    entry.verifyStreak += 1
    entry.timer = this.schedule(delayMs, () => {
      entry.timer = null
      this.trigger(entry, { source: 'verify' })
    })
  }

  private trigger(entry: Supervised, trigger: Trigger): void {
    if (this.supervised.get(entry.key) !== entry || (this.suspended && trigger === 'heartbeat')) {
      return
    }
    noteSupervisedExit(entry, trigger, this.now())
    if (entry.busy) {
      // An exit or a re-verify outranks a heartbeat.
      if (entry.pending === null || trigger !== 'heartbeat') {
        entry.pending = trigger
      }
      return
    }
    entry.busy = true
    void this.run(entry, trigger)
      .catch((error: unknown) => console.warn(`[wsl] liveness of ${entry.distro} failed:`, error))
      .finally(() => {
        entry.busy = false
        const next = entry.pending
        entry.pending = null
        if (next) {
          this.trigger(entry, next)
        }
      })
  }

  private async run(entry: Supervised, trigger: Trigger): Promise<void> {
    const generation = entry.generation
    let running = await this.deps.readRunning()
    if (entry.generation !== generation) {
      return
    }
    if (isWatchOrHolderExit(trigger) && confirmsRunning(running, entry.key)) {
      // Stopping distros can still appear running; wait before exec accidentally boots them again.
      await new Promise<void>((resolve) => this.schedule(EXIT_SETTLE_MS, resolve))
      running = await this.deps.readRunning({ distro: entry.distro, exitedAt: entry.lastExitMs })
      if (entry.generation !== generation) {
        return
      }
    }
    if (trigger === 'heartbeat' && entry.watch?.proving() && confirmsRunning(running, entry.key)) {
      await ensureHolderQuietly(this.deps.ensureHolder, entry.distro)
      this.scheduleHeartbeat(entry)
      return
    }
    const evidence: WslLivenessEvidence = {
      trigger: trigger === 'heartbeat' ? { source: 'verify' } : trigger,
      running:
        running.status === 'confirmed'
          ? { status: 'confirmed', running: confirmsRunning(running, entry.key) }
          : { status: 'unavailable' },
      expected: entry.expected
    }
    const connection = this.deps.manager.get(entry.distro)
    await gatherWslLivenessEvidence(evidence, {
      readIdentity: () => this.deps.readIdentity(entry.distro, connection?.pid ?? null),
      probePort: () => probeOrcadPort(entry, connection, (held) => this.attachWatch(entry, held))
    })
    if (entry.generation === generation) {
      await this.act(entry, classifyWslOrcadLiveness(evidence))
    }
  }

  private async act(entry: Supervised, verdict: WslLivenessVerdict): Promise<void> {
    switch (verdict.kind) {
      case 'live': {
        entry.verifyStreak = 0
        const connection = this.deps.manager.get(entry.distro)
        if (!entry.watch && connection) {
          await this.attachWatch(entry, connection)
        }
        if (entry.state !== 'ready') {
          this.publish(entry, { state: 'ready', census: null })
        }
        await ensureHolderQuietly(this.deps.ensureHolder, entry.distro)
        this.scheduleHeartbeat(entry)
        return
      }
      case 'unverifiable':
        // Lost contact is not death; retain surviving watches and recheck.
        if (entry.state !== 'unverifiable') {
          this.publish(entry, {
            state: 'unverifiable',
            reason: verdict.reason,
            terminals: 'unverifiable'
          })
        }
        this.scheduleVerify(entry)
        return
      case 'distro-stopped':
        return this.onDistroStopped(entry)
      case 'distro-restarted':
        disarmSupervised(entry)
        return this.recover(entry, 'distro-restarted')
      case 'orcad-exited':
        disarmSupervised(entry)
        if (!this.deps.hasUserVisibleWork(entry.distro)) {
          // Relaunch without visible demand would defeat managed orcad idle exit.
          this.publish(entry, { state: 'idle', terminals: 'unverifiable' })
          return this.deps.manager.retireListener(entry.distro)
        }
        return this.recover(entry, 'orcad-exited')
    }
  }

  private async onDistroStopped(entry: Supervised): Promise<void> {
    disarmSupervised(entry)
    // Holder and watch exit together; publish distro-stop once.
    if (entry.state !== 'distro-stopped') {
      this.publish(entry, { state: 'distro-stopped', terminals: 'exited', recovering: false })
    }
    // Read before the retire: a connect starting during it must make the deferred verify a no-op.
    const { generation, key } = entry
    await this.deps.manager.retireListener(entry.distro)
    // A confirmed stop stays down, even with visible work, until the user or a running distro (E9).
    const verify = (): unknown => entry.generation === generation && this.trigger(entry, VERIFY)
    this.deps.deferUntilRunning(entry.distro, `wsl-orcad-liveness:${key}`, verify)
  }

  private async recover(entry: Supervised, reason: WslOrcadRecoveryReason): Promise<void> {
    const generation = entry.generation
    // Recovery is never a user act: its reconnect re-checks the distro runs right before spawning.
    const requireRunning = this.deps.requireRunning
    const gated = await recoverWslOrcad(
      {
        distro: entry.distro,
        backoff: entry.backoff,
        now: this.now,
        current: () => entry.generation === generation,
        wait: (delayMs) => cancellableWait(entry, this.schedule, delayMs),
        publish: (status) => this.publish(entry, status),
        ensure: (options) => this.deps.manager.ensure(entry.distro, { ...options, requireRunning }),
        collectCensus: this.deps.collectCensus,
        arm: (connection) => this.arm(entry, connection),
        readRunning: this.deps.readRunning
      },
      reason
    )
    if (gated && entry.generation === generation) {
      await this.act(entry, gated)
    }
  }
}
