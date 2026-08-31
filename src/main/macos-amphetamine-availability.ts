import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'

/** Sticky availability verdict cleared only by an explicit retry. */
export class AmphetamineAvailability {
  private reason: AmphetamineUnavailableReason | null = null

  /** Returns true only on a change, so callers report each verdict once. */
  mark(reason: AmphetamineUnavailableReason): boolean {
    if (this.reason === reason) {
      return false
    }
    this.reason = reason
    return true
  }

  /** Returns true only if a verdict was actually forgotten. */
  clear(): boolean {
    if (!this.reason) {
      return false
    }
    this.reason = null
    return true
  }

  get(): AmphetamineUnavailableReason | null {
    return this.reason
  }

  isUnavailable(): boolean {
    return this.reason !== null
  }
}
