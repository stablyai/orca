import { readFileSync } from 'node:fs'
import { checkDaemonHealth, type DaemonHealth } from './daemon-health'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouter } from './daemon-pty-router'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  unlinkOwnedDaemonPidFile,
  unlinkOwnedDaemonTokenFile
} from './daemon-spawner'
import { trackDaemonRetired } from './daemon-lifecycle-event'

// Advisory bookkeeping only -- processGeneration() re-derives the real outcome every
// tick from the router's live state, so a generation stuck (say) in
// 'handoff-in-progress' is simply retried, never gated on its own prior state.
export type DaemonGenerationRetirementState =
  | 'discovered'
  | 'handoff-in-progress'
  | 'verified-empty'
  | 'retiring'
  | 'retired'

// Why seconds-to-minutes, never sub-second: matches every other legacy-generation
// poll cadence already in this codebase -- getDaemonLiveSessionCount() call sites
// (daemon-pty-daemon-recovery.ts) all run before a deliberate replace, never on a
// tight loop, and design doc section 6 asks for the same bound here.
export const DEFAULT_RETIREMENT_POLL_INTERVAL_MS = 30_000

// Why 5000: mirrors daemon-entry.ts's own SHUTDOWN_TIMEOUT_MS bound for its
// SIGTERM-then-wait clean-shutdown path. Retirement escalates to SIGKILL only
// after the SAME bounded wait the daemon already budgets for itself -- not a new
// timeout invented for this scheduler.
export const DEFAULT_RETIREMENT_SIGKILL_GRACE_MS = 5_000

const SIGKILL_POLL_INTERVAL_MS = 100

export type DaemonGenerationRetirementDeps = {
  router: DaemonPtyRouter
  runtimeDir: string
  pollIntervalMs?: number
  sigkillGraceMs?: number
  // Test seams; production defaults use the real clock/fs/process primitives.
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  killPid?: (pid: number, signal: NodeJS.Signals) => void
  isPidAlive?: (pid: number) => boolean
  checkHealth?: (
    socketPath: string,
    tokenPath: string,
    protocolVersion: number
  ) => Promise<DaemonHealth>
  readPidFile?: (pidPath: string) => string
  readTokenFile?: (tokenPath: string) => string
  unlinkPidFile?: typeof unlinkOwnedDaemonPidFile
  unlinkTokenFile?: typeof unlinkOwnedDaemonTokenFile
  trackRetired?: typeof trackDaemonRetired
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Why bare process.kill(pid, 0) is safe HERE and only here: this scheduler never
    // uses it to decide WHETHER to send a signal (that decision is the health probe
    // in retireIfHealthy, per the recycled-pid guard design doc section 6 names).
    // It is used only to poll for the exit of a process THIS SAME PASS already
    // health-verified and already signaled a moment earlier.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Policy for retiring a discovered legacy daemon generation once every session it
 * owns has either been handed off to `current` (Tier 1, idle) or exited on its own;
 * a session still reporting busy (Tier 2) is never touched, only supervised. See
 * docs/plans/2026-09-16_1859_daemon-generation-adoption-design.md sections 4 and 6.
 */
export class DaemonGenerationRetirementScheduler {
  private readonly router: DaemonPtyRouter
  private readonly runtimeDir: string
  private readonly pollIntervalMs: number
  private readonly sigkillGraceMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void
  private readonly isPidAlive: (pid: number) => boolean
  private readonly checkHealth: (
    socketPath: string,
    tokenPath: string,
    protocolVersion: number
  ) => Promise<DaemonHealth>
  private readonly readPidFile: (pidPath: string) => string
  private readonly readTokenFile: (tokenPath: string) => string
  private readonly unlinkPidFile: typeof unlinkOwnedDaemonPidFile
  private readonly unlinkTokenFile: typeof unlinkOwnedDaemonTokenFile
  private readonly trackRetired: typeof trackDaemonRetired

  private readonly states = new Map<DaemonPtyAdapter, DaemonGenerationRetirementState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight: Promise<void> | null = null

  constructor(deps: DaemonGenerationRetirementDeps) {
    this.router = deps.router
    this.runtimeDir = deps.runtimeDir
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_RETIREMENT_POLL_INTERVAL_MS
    this.sigkillGraceMs = deps.sigkillGraceMs ?? DEFAULT_RETIREMENT_SIGKILL_GRACE_MS
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    // Why process.kill and not a dedicated signal library: the cross-platform
    // delivery layer is Node's own signal emulation -- the same one daemon-entry.ts
    // already relies on for the current generation's clean shutdown (design doc
    // section 6). Reusing it here is the point; a second mechanism is not added.
    this.killPid = deps.killPid ?? ((pid, signal) => process.kill(pid, signal))
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
    this.checkHealth = deps.checkHealth ?? checkDaemonHealth
    this.readPidFile = deps.readPidFile ?? ((pidPath) => readFileSync(pidPath, 'utf8'))
    this.readTokenFile =
      deps.readTokenFile ?? ((tokenPath) => readFileSync(tokenPath, 'utf8').trim())
    this.unlinkPidFile = deps.unlinkPidFile ?? unlinkOwnedDaemonPidFile
    this.unlinkTokenFile = deps.unlinkTokenFile ?? unlinkOwnedDaemonTokenFile
    this.trackRetired = deps.trackRetired ?? trackDaemonRetired
  }

  /** Poll on an idle tick -- never a tight loop (design doc section 6). */
  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getState(adapter: DaemonPtyAdapter): DaemonGenerationRetirementState | undefined {
    return this.states.get(adapter)
  }

  /** One scheduler pass over every currently-discovered legacy generation. */
  async tick(): Promise<void> {
    if (this.tickInFlight) {
      return this.tickInFlight
    }
    const run = this.runTick().finally(() => {
      if (this.tickInFlight === run) {
        this.tickInFlight = null
      }
    })
    this.tickInFlight = run
    return run
  }

  private async runTick(): Promise<void> {
    for (const adapter of this.router.getLegacyAdapters()) {
      await this.processGeneration(adapter)
    }
  }

  private async processGeneration(adapter: DaemonPtyAdapter): Promise<void> {
    if (!this.states.has(adapter)) {
      this.states.set(adapter, 'discovered')
    }
    await this.attemptHandoff(adapter)
    const empty = await this.verifyEmpty(adapter)
    if (!empty) {
      this.states.set(adapter, 'handoff-in-progress')
      return
    }
    this.states.set(adapter, 'verified-empty')
    await this.retireIfHealthy(adapter)
  }

  // Tier 1 (idle) and Tier 2 (busy) split, design doc section 4.2.
  private async attemptHandoff(adapter: DaemonPtyAdapter): Promise<void> {
    let sessions: { sessionId: string }[]
    try {
      sessions = await adapter.listSessions()
    } catch {
      // Best-effort discovery; retried next tick.
      return
    }
    for (const session of sessions) {
      let busy: boolean
      try {
        busy = await adapter.hasChildProcesses(session.sessionId)
      } catch {
        // Why conservative-busy: an unproven idle read must never authorize
        // touching the PTY. A session whose busy state could not be established
        // is treated exactly like Tier 2 -- supervised, never forced.
        continue
      }
      if (busy) {
        continue
      }
      // handoffIdleLegacySession() itself re-checks the version gate and never
      // retargets the route unless the replacement PTY on `current` is confirmed
      // alive; a false return here just means this session stays owned by
      // `adapter`, so verifyEmpty() below correctly keeps the generation supervised.
      await this.router.handoffIdleLegacySession(adapter, session.sessionId)
    }
  }

  // Design doc section 4.3.1: zero remaining processes, or every remaining one
  // already owned by `current` post-handoff.
  private async verifyEmpty(adapter: DaemonPtyAdapter): Promise<boolean> {
    let processes: { id: string }[]
    try {
      processes = await adapter.listProcesses()
    } catch {
      return false
    }
    if (processes.length === 0) {
      return true
    }
    const ownedByCurrent = new Set(this.router.sessionsOwnedBy(this.router.getCurrentAdapter()))
    return processes.every((process) => ownedByCurrent.has(process.id))
  }

  // Design doc sections 4.3.2 (recycled-pid guard) and 4.4 (retirement).
  private async retireIfHealthy(adapter: DaemonPtyAdapter): Promise<void> {
    const protocolVersion = adapter.protocolVersion
    const pidPath = getDaemonPidPath(this.runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(this.runtimeDir, protocolVersion)
    const socketPath = getDaemonSocketPath(this.runtimeDir, protocolVersion)

    // Why a health probe before ANY signal: a pid file can outlive the process it
    // named if the OS recycles the pid. Only a daemon that still answers its OWN
    // socket+token identity check is provably the same process the pid record was
    // written for; anything else (including a transient probe failure) aborts this
    // pass rather than risk signaling an unrelated process -- retried next tick.
    let health: DaemonHealth
    try {
      health = await this.checkHealth(socketPath, tokenPath, protocolVersion)
    } catch {
      return
    }
    if (health !== 'healthy' && health !== 'pty-spawn-unhealthy') {
      return
    }

    let pidRecordContents: string
    try {
      pidRecordContents = this.readPidFile(pidPath)
    } catch {
      return
    }
    const parsed = parseDaemonPidFile(pidRecordContents)
    if (!parsed) {
      return
    }

    this.states.set(adapter, 'retiring')
    this.killPid(parsed.pid, 'SIGTERM')
    await this.waitForExit(parsed.pid, this.sigkillGraceMs)
    if (this.isPidAlive(parsed.pid)) {
      this.killPid(parsed.pid, 'SIGKILL')
      await this.waitForExit(parsed.pid, this.sigkillGraceMs)
    }
    if (this.isPidAlive(parsed.pid)) {
      // Why never unlink or retire here: the on-disk record still names a live
      // process. Removing it would let a replacement daemon collide with a
      // generation that never actually exited. Retried next tick.
      return
    }

    this.unlinkPidFile(pidPath, parsed.pid, parsed.launchNonce)
    let tokenContents: string | null = null
    try {
      tokenContents = this.readTokenFile(tokenPath)
    } catch {
      tokenContents = null
    }
    if (tokenContents !== null) {
      this.unlinkTokenFile(tokenPath, tokenContents)
    }

    // Why after cleanup, never before: retireLegacyAdapter() removes the adapter
    // from the router's legacy array and disposes it, so it must not run until the
    // process it fronted is confirmed gone and its on-disk identity is reclaimed.
    this.router.retireLegacyAdapter(adapter)
    this.states.set(adapter, 'retired')
    this.trackRetired('generation_handoff_complete')
  }

  private async waitForExit(pid: number, graceMs: number): Promise<void> {
    const deadline = this.now() + graceMs
    while (this.isPidAlive(pid) && this.now() < deadline) {
      await this.sleep(Math.min(SIGKILL_POLL_INTERVAL_MS, Math.max(0, deadline - this.now())))
    }
  }
}
