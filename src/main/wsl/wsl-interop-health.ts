import { listRunningWslDistrosAsync, listWslDistrosAsync } from '../wsl'
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
  listRunningDistros(): Promise<string[]>
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

// Why delayed: the spawn that reported activity is what boots the distro, and the check must never be the one that does.
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

/**
 * Detects and restores a wiped `WSLInterop` entry in distros Orca is using.
 *
 * Why automatic: the missing entry is a WSL bug state, not a user choice; the
 * repair re-registers exactly what WSL's init registers at boot, it is
 * idempotent, and a prompt would ask users to approve something they cannot
 * diagnose. `[interop] enabled=false` in the distro's wsl.conf is respected.
 */
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
        void this.check(name, { confirmRunning: true })
      }, ACTIVITY_CHECK_DELAY_MS)
    })
  }

  /** A stopping systemd distro is exactly when the wipe happens; re-check the ones still up. */
  private onDistrosStopped(_stopped: string[], running: string[]): void {
    const runningKeys = new Set(running.map((name) => name.toLowerCase()))
    for (const [key, health] of this.distros) {
      if (runningKeys.has(key) && this.deps.now() - health.lastCheckAt >= STOP_CHECK_FLOOR_MS) {
        // The confirmed list that reported the stop also proves this distro is up.
        void this.check(health.name, { confirmRunning: false })
      }
    }
  }

  check(distro: string, options: { confirmRunning: boolean }): Promise<WslInteropCheckOutcome> {
    const health = this.healthFor(distro)
    if (health.inFlight) {
      return health.inFlight
    }
    health.lastCheckAt = this.deps.now()
    const run = this.runCheck(health, options.confirmRunning)
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

  private async runCheck(
    health: DistroHealth,
    confirmRunning: boolean
  ): Promise<WslInteropCheckOutcome> {
    const distro = health.name
    if (confirmRunning && !(await this.isRunning(distro))) {
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
      const running = await this.deps.listRunningDistros()
      return running.some((name) => name.toLowerCase() === distro.toLowerCase())
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
  listRunningDistros: () => listRunningWslDistrosAsync({ requireConfirmed: true }),
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
