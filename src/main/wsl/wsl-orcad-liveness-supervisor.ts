/**
 * Keeps each WSL distro's orcad connection honest (design D2c, step C6): a held watch bridge
 * reports exits within tens of milliseconds, each exit is classified against a confirmed running
 * list and the guest's process identity, and the verdict drives recovery. Every status change
 * goes out through the connection manager's `onChange`.
 *
 * Never boots a distro for background work: a stopped distro comes back only while a user-visible
 * WSL project or terminal needs it, otherwise once the background gate next sees it running.
 * Timers are monotonic, and a power resume re-verifies instead of trusting them.
 */
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectIntent, WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { recoverWslOrcad, type WslOrcadRecoveryReason } from './wsl-orcad-liveness-recovery'
import {
  confirmsRunning,
  EXIT_SETTLE_MS,
  failedExit,
  gatherWslLivenessEvidence
} from './wsl-orcad-liveness-evidence'
import {
  attachSupervisedWatch,
  cancellableWait,
  defaultSchedule,
  ensureHolderQuietly,
  subscribeWake
} from './wsl-orcad-liveness-monitor'
import {
  disarmSupervised,
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
    // An unchanged bridge offer may stay quiet even when an earlier failure needs clearing.
    const reportReady = entry.busy || (entry.state !== null && entry.state !== 'ready')
    // Supersedes a recovery or deferred re-check: this connect relaunches and re-arms itself.
    const generation = (entry.generation += 1)
    disarmSupervised(entry)
    let connection: WslOrcadConnection
    try {
      connection = await this.deps.manager.ensure(entry.distro, options)
    } catch (error) {
      // e.g. a rejected update: the incumbent still serves and must stay watched.
      const incumbent = this.deps.manager.get(entry.distro)
      if (incumbent && entry.generation === generation) {
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

  private entryFor(distro: string): Supervised {
    const key = wslDistroHolderKey(distro)
    const existing = this.supervised.get(key)
    if (existing) {
      return existing
    }
    const entry = newSupervised(
      distro,
      key,
      this.now(),
      new WslOrcadReconnectBackoff(this.deps.random)
    )
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
    // A later connect owns the timer now; this arm must not replace it.
    if (entry.generation === generation) {
      this.scheduleHeartbeat(entry)
    }
  }

  private attachWatch(entry: Supervised, connection: WslOrcadConnection) {
    return attachSupervisedWatch(
      entry,
      () => this.deps.openWatch(connection),
      (code) => this.trigger(entry, { source: 'bridge', code })
    )
  }

  private scheduleHeartbeat(entry: Supervised): void {
    entry.timer?.cancel()
    entry.lastBeatMs = this.now()
    entry.timer = this.schedule(this.heartbeatMs, () => {
      entry.timer = null
      // A tick far past due means this process or the VM was paused: verify everything.
      const late = this.now() - entry.lastBeatMs > this.heartbeatMs * 2
      this.trigger(entry, late ? { source: 'verify' } : 'heartbeat')
    })
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
    if (failedExit(trigger) && confirmsRunning(running, entry.key)) {
      // A stopping distro can still list as running; an exec into it then would boot it again.
      await new Promise<void>((resolve) => this.schedule(EXIT_SETTLE_MS, resolve))
      running = await this.deps.readRunning()
      if (entry.generation !== generation) {
        return
      }
    }
    if (trigger === 'heartbeat' && entry.watch && confirmsRunning(running, entry.key)) {
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
      // Opening a watch is the port probe; a held one already proved the port.
      probePort: async () =>
        connection && !entry.watch ? this.attachWatch(entry, connection) : 'ready'
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
        // Loss of contact is not death: keep any watch that survives and look again later.
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
          // A managed orcad idle-exits; relaunching it for nobody would undo that every time.
          this.publish(entry, { state: 'idle', terminals: 'unverifiable' })
          return
        }
        return this.recover(entry, 'orcad-exited')
    }
  }

  private async onDistroStopped(entry: Supervised): Promise<void> {
    disarmSupervised(entry)
    const recovering = this.deps.hasUserVisibleWork(entry.distro)
    // The holder and the watch both exit on a stop; report it once.
    if (recovering || entry.state !== 'distro-stopped') {
      this.publish(entry, { state: 'distro-stopped', terminals: 'exited', recovering })
    }
    if (recovering) {
      return this.recover(entry, 'distro-stopped')
    }
    // Never boot it for background work; the gate runs this once something else starts it.
    const generation = entry.generation
    this.deps.deferUntilRunning(entry.distro, `wsl-orcad-liveness:${entry.key}`, () => {
      if (entry.generation === generation) {
        this.trigger(entry, { source: 'verify' })
      }
    })
  }

  private async recover(entry: Supervised, reason: WslOrcadRecoveryReason): Promise<void> {
    const generation = entry.generation
    const gated = await recoverWslOrcad(
      {
        distro: entry.distro,
        backoff: entry.backoff,
        now: this.now,
        current: () => entry.generation === generation,
        wait: (delayMs) => cancellableWait(entry, this.schedule, delayMs),
        publish: (status) => this.publish(entry, status),
        ensure: (options) => this.deps.manager.ensure(entry.distro, options),
        collectCensus: this.deps.collectCensus,
        arm: (connection) => this.arm(entry, connection),
        hasUserVisibleWork: () => this.deps.hasUserVisibleWork(entry.distro),
        readRunning: this.deps.readRunning
      },
      reason
    )
    if (gated && entry.generation === generation) {
      await this.act(entry, gated)
    }
  }
}
