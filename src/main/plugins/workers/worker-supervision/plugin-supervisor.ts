// Pure supervision policy adapted from community PR #5801 (gsxdsm); callers own timers and process operations.

export type PluginRunState = 'inactive' | 'running' | 'restarting' | 'errored'

export type PluginExitInfo = {
  crashed: boolean
}

export type PluginRestartDecision =
  | { restart: true; delayMs: number; attempt: number }
  | { restart: false; state: PluginRunState }

export type PluginSupervisionConfig = {
  /** Zero disables restarts; the first crash marks errored. */
  maxRestarts: number
  /** Reuse the final delay after exhausting this nonempty schedule. */
  backoffMs: number[]
}

const DEFAULT_CONFIG: PluginSupervisionConfig = {
  maxRestarts: 3,
  backoffMs: [500, 2000, 5000]
}

type Entry = { state: PluginRunState; restarts: number }

export class PluginSupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly config: PluginSupervisionConfig

  constructor(config: Partial<PluginSupervisionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // Empty schedules would produce immediate restart loops.
    if (this.config.maxRestarts < 0) {
      throw new Error('PluginSupervisionConfig.maxRestarts must be >= 0')
    }
    if (this.config.backoffMs.length === 0) {
      throw new Error('PluginSupervisionConfig.backoffMs must be non-empty')
    }
  }

  getState(id: string): PluginRunState {
    return this.entries.get(id)?.state ?? 'inactive'
  }

  restartCount(id: string): number {
    return this.entries.get(id)?.restarts ?? 0
  }

  /** Fresh activation resets crash history; restarts preserve it. */
  markRunning(id: string, options: { resetRestarts?: boolean } = {}): void {
    const prior = this.entries.get(id)
    this.entries.set(id, {
      state: 'running',
      restarts: options.resetRestarts ? 0 : (prior?.restarts ?? 0)
    })
  }

  markExited(id: string, info: PluginExitInfo): PluginRestartDecision {
    if (!info.crashed) {
      this.entries.set(id, { state: 'inactive', restarts: 0 })
      return { restart: false, state: 'inactive' }
    }
    const entry = this.entries.get(id)
    if (!entry) {
      return { restart: false, state: 'inactive' }
    }
    if (entry.restarts >= this.config.maxRestarts) {
      this.entries.set(id, { state: 'errored', restarts: entry.restarts })
      return { restart: false, state: 'errored' }
    }
    const attempt = entry.restarts + 1
    const idx = Math.max(0, Math.min(entry.restarts, this.config.backoffMs.length - 1))
    this.entries.set(id, { state: 'restarting', restarts: attempt })
    return { restart: true, delayMs: this.config.backoffMs[idx]!, attempt }
  }

  reset(id: string): void {
    this.entries.delete(id)
  }
}
