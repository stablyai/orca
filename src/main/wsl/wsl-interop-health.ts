import { listWslDistrosAsync } from '../wsl'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { onRunningWslDistrosStopped } from '../wsl-running-distro-cache'
import { runWslProcess } from './wsl-runner'
import {
  parseWslInteropProbeOutput,
  parseWslInteropRepairOutput,
  WSL_INTEROP_PROBE_SCRIPT,
  WSL_INTEROP_REPAIR_SCRIPT
} from './wsl-interop-registration'

export type WslInteropCheckOutcome =
  | 'intact'
  | 'repaired'
  | 'interop-disabled'
  | 'unsupported'
  | 'repair-failed'
  | 'not-running'
  | 'unknown'

export type WslInteropHealthDeps = {
  platform(): NodeJS.Platform
  /** A settled running read: a list taken while a distro stops can still name it. */
  isRunning(distro: string): Promise<boolean>
  resolveDefaultDistro(): Promise<string | null>
  runScript(
    distro: string,
    script: string,
    user?: 'root'
  ): Promise<{ code: number | null; stdout: string }>
  subscribeStops(listener: (stopped: string[], running: string[]) => void): () => void
  now(): number
  schedule(fn: () => void, delayMs: number): void
  log(message: string): void
}

// Activity spawns boot distros; delay checks so the health probe never boots one itself.
export const ACTIVITY_CHECK_DELAY_MS = 5_000
export const ACTIVITY_CHECK_INTERVAL_MS = 60_000
// A stop-triggered check bypasses the activity interval but not this floor.
export const STOP_CHECK_FLOOR_MS = 5_000
export const REPAIR_FAILURE_BACKOFF_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 10_000

type DistroHealth = {
  name: string
  lastCheckAt: number
  repairFailedAt: number
  scheduled: boolean
  inFlight: Promise<WslInteropCheckOutcome> | null
}

/** Restore WSL's own idempotent interop registration after the VM-wide wipe bug; respect explicit wsl.conf interop disablement. */
export class WslInteropHealthMonitor {
  private readonly distros = new Map<string, DistroHealth>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: WslInteropHealthDeps) {}

  /** A WSL terminal is starting in `distro` (null: the default distro). */
  noteActivity(distro: string | null): void {
    if (this.deps.platform() !== 'win32') {
      return
    }
    this.unsubscribe ??= this.deps.subscribeStops((stopped, running) =>
      this.onDistrosStopped(stopped, running)
    )
    void this.resolveName(distro).then((name) => {
      if (!name) {
        return
      }
      const health = this.healthFor(name)
      if (health.scheduled || this.deps.now() - health.lastCheckAt < ACTIVITY_CHECK_INTERVAL_MS) {
        return
      }
      health.scheduled = true
      this.deps.schedule(() => {
        health.scheduled = false
        void this.check(name)
      }, ACTIVITY_CHECK_DELAY_MS)
    })
  }

  /** A stopping systemd distro is exactly when the wipe happens; re-check the ones still up. */
  private onDistrosStopped(_stopped: string[], running: string[]): void {
    const runningKeys = new Set(running.map((name) => name.toLowerCase()))
    for (const [key, health] of this.distros) {
      if (runningKeys.has(key) && this.deps.now() - health.lastCheckAt >= STOP_CHECK_FLOOR_MS) {
        // The stop's list can still name a distro that is stopping too; check() takes a settled read (E9).
        void this.check(health.name)
      }
    }
  }

  check(distro: string): Promise<WslInteropCheckOutcome> {
    const health = this.healthFor(distro)
    if (health.inFlight) {
      return health.inFlight
    }
    health.lastCheckAt = this.deps.now()
    const run = this.runCheck(health)
      .catch((error: unknown) => {
        this.deps.log(`[wsl] interop check failed for ${distro}: ${String(error)}`)
        return 'unknown' as const
      })
      .finally(() => {
        if (health.inFlight === run) {
          health.inFlight = null
        }
      })
    health.inFlight = run
    return run
  }

  private async runCheck(health: DistroHealth): Promise<WslInteropCheckOutcome> {
    const distro = health.name
    if (!(await this.isRunning(distro))) {
      return 'not-running'
    }
    const probe = await this.deps.runScript(distro, WSL_INTEROP_PROBE_SCRIPT)
    const result = parseWslInteropProbeOutput(probe.stdout)
    if (result.state === 'present') {
      return 'intact'
    }
    if (result.state === 'unmounted') {
      return 'unsupported'
    }
    if (result.state === 'unknown') {
      return 'unknown'
    }
    if (result.interopDisabled) {
      return 'interop-disabled'
    }
    if (this.deps.now() - health.repairFailedAt < REPAIR_FAILURE_BACKOFF_MS) {
      return 'repair-failed'
    }
    // A missing entry is what a stopping distro's systemd leaves; the repair must not restart it.
    if (!(await this.isRunning(distro))) {
      return 'not-running'
    }
    const repair = await this.deps.runScript(distro, WSL_INTEROP_REPAIR_SCRIPT, 'root')
    const repaired = repair.code === 0 ? parseWslInteropRepairOutput(repair.stdout) : 'unknown'
    if (repaired === 'unknown') {
      health.repairFailedAt = this.deps.now()
      this.deps.log(`[wsl] could not restore Windows interop in ${distro} (exit ${repair.code})`)
      return 'repair-failed'
    }
    if (repaired === 'present') {
      // Another repair (or WSL itself) restored it between probe and repair.
      return 'intact'
    }
    this.deps.log(
      `[wsl] restored the WSLInterop binfmt entry from ${distro}; another distro's systemd ` +
        'shutdown removed it (fixed in WSL 3.0.1, run `wsl --update`)'
    )
    return 'repaired'
  }

  private async isRunning(distro: string): Promise<boolean> {
    try {
      return await this.deps.isRunning(distro)
    } catch {
      // Unconfirmed: `wsl -d` would boot a stopped distro, so skip.
      return false
    }
  }

  private async resolveName(distro: string | null): Promise<string | null> {
    const trimmed = distro?.trim()
    if (trimmed) {
      return trimmed
    }
    try {
      return await this.deps.resolveDefaultDistro()
    } catch {
      return null
    }
  }

  private healthFor(distro: string): DistroHealth {
    const key = distro.toLowerCase()
    let health = this.distros.get(key)
    if (!health) {
      health = {
        name: distro,
        lastCheckAt: -Infinity,
        repairFailedAt: -Infinity,
        scheduled: false,
        inFlight: null
      }
      this.distros.set(key, health)
    }
    return health
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.distros.clear()
  }
}

export const wslInteropHealthMonitor = new WslInteropHealthMonitor({
  platform: () => process.platform,
  isRunning: (distro) => isWslDistroRunning(distro),
  resolveDefaultDistro: async () => (await listWslDistrosAsync())[0] ?? null,
  runScript: (distro, script, user) =>
    runWslProcess({ distro, user, loginPath: 'none', script, timeoutMs: PROBE_TIMEOUT_MS }),
  subscribeStops: onRunningWslDistrosStopped,
  now: () => Date.now(),
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs).unref?.()
  },
  log: (message) => console.warn(message)
})
