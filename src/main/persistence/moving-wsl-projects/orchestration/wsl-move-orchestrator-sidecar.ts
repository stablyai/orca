/**
 * The orchestrator's hold on its sidecar: until one load has read the file, no automatic step
 * runs and nothing is saved, since an empty map written back would erase other distros' declines.
 */
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'

/** Waits before re-trying a save a sharing violation refused (another process held the file). */
export const WSL_MOVE_SIDECAR_SAVE_RETRY_MS = [50, 250, 1_000] as const

function isTransientSaveError(error: unknown): boolean {
  const code = errnoCodeOrUnknown(error)
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

export class WslMoveOrchestratorSidecar {
  private loaded = false
  /** Distros whose record only a newer build can parse: automatic steps leave them alone. */
  private readonly unknown = new Set<string>()
  private saveRetries = 0
  private cancelRetry: (() => void) | null = null

  constructor(
    private readonly ports: Pick<WslMoveOrchestratorPorts, 'load' | 'save' | 'schedule'>
  ) {}

  /** The records read the first time the file is readable; null while it is not, or once read. */
  tryLoad(): Map<string, WslMoveOrchestratorRecord> | null {
    if (this.loaded) {
      return null
    }
    const result = this.ports.load()
    if (result.kind === 'unreadable') {
      return null
    }
    this.loaded = true
    if (result.kind === 'missing') {
      return new Map()
    }
    for (const key of result.unknownKeys) {
      this.unknown.add(key)
    }
    return result.records
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  holdsAutomaticSteps(key: string): boolean {
    return !this.loaded || this.unknown.has(key)
  }

  /** The user acted on the distro: their record now replaces the one this build could not parse. */
  releasedByUser(key: string): void {
    this.unknown.delete(key)
  }

  /** `records` is the live map, so a retried save writes whatever is current by then. */
  save(records: ReadonlyMap<string, WslMoveOrchestratorRecord>): void {
    if (!this.loaded) {
      return
    }
    this.cancelRetry?.()
    this.cancelRetry = null
    try {
      this.ports.save(records)
      this.saveRetries = 0
    } catch (error) {
      const delay = WSL_MOVE_SIDECAR_SAVE_RETRY_MS[this.saveRetries]
      if (isTransientSaveError(error) && delay !== undefined) {
        this.saveRetries++
        this.cancelRetry = this.ports.schedule(delay, () => {
          this.cancelRetry = null
          this.save(records)
        })
        return
      }
      this.saveRetries = 0
      // The sidecar is the orchestrator's memory, not the move's record: keep going in memory.
      console.warn('[wsl-move] Orchestrator state not saved:', error)
    }
  }
}
