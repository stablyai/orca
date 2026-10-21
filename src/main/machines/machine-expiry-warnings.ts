import {
  MACHINE_EXPIRY_WARNING_MS,
  machineExpiryWarningKey,
  machineMsUntilExpiry,
  type MachineExpiryWarning,
  type MachineProviderSnapshot,
  type MachineRecord,
  type MachineWorkAtRisk
} from '../../shared/machine-inventory'

// setTimeout overflows past ~24.8 days; a far expiry is re-armed by the next reschedule.
const MAX_TIMER_MS = 24 * 60 * 60_000

export type MachineExpiryWarningDeps = {
  snapshots: () => readonly MachineProviderSnapshot[]
  hasWarned: (key: string) => boolean
  markWarned: (key: string, liveKeys: ReadonlySet<string>) => void
  /** null means the machine's worktrees could not be read. */
  readWorkAtRisk: (machine: MachineRecord) => Promise<MachineWorkAtRisk | null>
  /** `key` is the dedupe key, stable for this machine and expiry. */
  warn: (warning: MachineExpiryWarning, machine: MachineRecord, key: string) => void
  now?: () => number
}

/**
 * Warns once per temporary machine per expiry, 15 minutes before it is deleted. Runs in main on
 * plain timers, so it fires while every window is hidden; the dedupe is persisted with the
 * inventory, so a relaunch inside the window does not warn again.
 */
export class MachineExpiryWarnings {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly active = new Map<string, MachineExpiryWarning>()

  constructor(private readonly deps: MachineExpiryWarningDeps) {}

  /** Re-arms every timer from the current inventory; call after each inventory change. */
  reschedule(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    const now = this.now()
    const live = new Set<string>()
    for (const snapshot of this.deps.snapshots()) {
      for (const machine of snapshot.machines) {
        const remaining = machineMsUntilExpiry(machine, snapshot.clockOffsetMs, now)
        if (machine.lifetime !== 'temporary' || machine.state === 'gone' || remaining === null) {
          continue
        }
        const key = machineExpiryWarningKey(machine)
        live.add(key)
        if (remaining <= 0 || this.deps.hasWarned(key)) {
          continue
        }
        const delay = Math.min(Math.max(0, remaining - MACHINE_EXPIRY_WARNING_MS), MAX_TIMER_MS)
        const timer = setTimeout(() => {
          this.timers.delete(key)
          if (remaining - MACHINE_EXPIRY_WARNING_MS > MAX_TIMER_MS) {
            this.reschedule()
            return
          }
          void this.fire(key, machine, now + remaining, live)
        }, delay)
        timer.unref?.()
        this.timers.set(key, timer)
      }
    }
    for (const key of this.active.keys()) {
      if (!live.has(key)) {
        this.active.delete(key)
      }
    }
  }

  /** Warnings already raised for machines that still exist, for a renderer that reloads. */
  activeWarnings(): MachineExpiryWarning[] {
    return [...this.active.values()]
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private async fire(
    key: string,
    machine: MachineRecord,
    expiresAt: number,
    liveKeys: ReadonlySet<string>
  ): Promise<void> {
    if (this.deps.hasWarned(key)) {
      return
    }
    // Recorded before the slow read, so a reschedule meanwhile cannot warn twice.
    this.deps.markWarned(key, liveKeys)
    const workAtRisk = await this.deps.readWorkAtRisk(machine).catch(() => null)
    const warning: MachineExpiryWarning = {
      providerKey: machine.providerKey,
      machineId: machine.id,
      name: machine.name,
      expiresAt,
      workAtRisk
    }
    this.active.set(key, warning)
    this.deps.warn(warning, machine, key)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
