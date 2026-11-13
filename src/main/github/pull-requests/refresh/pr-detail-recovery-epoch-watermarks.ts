/** Live renderer scopes one caller may hold; more means old, reloaded instances. */
const MAX_SCOPES_PER_CALLER = 16
const MAX_CALLERS = 1_000
export const MAX_EPOCH_SCOPE_LENGTH = 128
// `g<renderer start ms>.<random>`: the generation orders one caller's renderer instances.
const EPOCH_SCOPE_PATTERN = /^g(\d{1,16})\.[\w-]{1,100}$/

function scopeGeneration(scope: string): number | null {
  const match = EPOCH_SCOPE_PATTERN.exec(scope)
  return match && scope.length <= MAX_EPOCH_SCOPE_LENGTH ? Number(match[1]) : null
}

export function isAdmissibleEpochScope(scope: string): boolean {
  return scopeGeneration(scope) !== null
}

type CallerEpochs = {
  scopes: Map<string, number>
  /** Scopes at or below this generation were retired; their epochs can never be readmitted. */
  retiredGeneration: number
}

/**
 * Accepted-epoch high-watermarks for the caller's whole lifetime: an old or retired epoch is never
 * readmitted, however long ago it settled. Memory stays bounded by retiring a caller's oldest
 * renderer scope (raising its floor) past the per-caller cap, by refusing new callers past the
 * global cap, and by dropping a caller only at its final retirement (its window is gone). A
 * runtime client reconnecting keeps the same caller, so reconnects never reset anti-replay.
 */
export class PRDetailRecoveryEpochWatermarks {
  private readonly callers = new Map<string, CallerEpochs>()

  isStale(callerKey: string, scope: string, counter: number): boolean {
    const caller = this.callers.get(callerKey)
    const generation = scopeGeneration(scope)
    if (!caller || generation === null) {
      return false
    }
    if (generation <= caller.retiredGeneration && !caller.scopes.has(scope)) {
      return true
    }
    const accepted = caller.scopes.get(scope)
    return accepted !== undefined && counter <= accepted
  }

  canAccept(callerKey: string): boolean {
    return this.callers.has(callerKey) || this.callers.size < MAX_CALLERS
  }

  accept(callerKey: string, scope: string, counter: number): void {
    const generation = scopeGeneration(scope)
    if (generation === null) {
      return
    }
    let caller = this.callers.get(callerKey)
    if (!caller) {
      caller = { scopes: new Map(), retiredGeneration: -1 }
      this.callers.set(callerKey, caller)
    }
    caller.scopes.set(scope, counter)
    while (caller.scopes.size > MAX_SCOPES_PER_CALLER) {
      let oldest: string | null = null
      for (const candidate of caller.scopes.keys()) {
        if (oldest === null || (scopeGeneration(candidate) ?? 0) < (scopeGeneration(oldest) ?? 0)) {
          oldest = candidate
        }
      }
      if (oldest === null) {
        break
      }
      caller.retiredGeneration = Math.max(caller.retiredGeneration, scopeGeneration(oldest) ?? 0)
      caller.scopes.delete(oldest)
    }
  }

  /** Final retirement only: the caller's window is gone and nothing it sent can arrive again. */
  forgetCaller(callerKey: string): void {
    this.callers.delete(callerKey)
  }
}
