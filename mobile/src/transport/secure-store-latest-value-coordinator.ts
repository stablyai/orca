type DesiredValue = { value: string } | null

type WriteState = {
  generation: number
  tombstoneGeneration: number
  desired: DesiredValue
  inFlight: number
  repairing: boolean
  retryDelayMs: number
  retryTimer: ReturnType<typeof setTimeout> | null
  tombstoned: boolean
}

type PersistValue = (key: string, desired: DesiredValue) => Promise<void>

export class SecureStoreLatestValueCoordinator {
  private readonly states = new Map<string, WriteState>()

  constructor(
    private readonly persist: PersistValue,
    private readonly setTimer: typeof setTimeout = setTimeout,
    private readonly clearTimer: typeof clearTimeout = clearTimeout
  ) {}

  pending(key: string): { present: boolean; value: string | null } {
    const state = this.states.get(key)
    return state
      ? { present: true, value: state.desired?.value ?? null }
      : { present: false, value: null }
  }

  isTombstoned(key: string): boolean {
    return this.states.get(key)?.tombstoned ?? false
  }

  write(key: string, value: string): Promise<void> {
    if (this.states.get(key)?.tombstoned) {
      return Promise.reject(new Error('secure value was deleted'))
    }
    return this.update(key, { value })
  }

  replace(key: string, value: string): Promise<void> {
    return this.update(key, { value }, true)
  }

  clear(key: string): Promise<void> {
    return this.update(key, null)
  }

  delete(key: string): Promise<void> {
    return this.update(key, null, false, true)
  }

  private async update(
    key: string,
    desired: DesiredValue,
    revive = false,
    tombstone = false
  ): Promise<void> {
    const state = this.states.get(key) ?? {
      generation: 0,
      tombstoneGeneration: 0,
      desired,
      inFlight: 0,
      repairing: false,
      retryDelayMs: 1_000,
      retryTimer: null,
      tombstoned: false
    }
    if (revive) {
      state.tombstoned = false
    }
    state.generation += 1
    if (tombstone) {
      state.tombstoned = true
      state.tombstoneGeneration = state.generation
    }
    state.desired = desired
    state.inFlight += 1
    this.states.set(key, state)
    const requestedGeneration = state.generation
    let generation = requestedGeneration
    let next = desired
    let repairingStaleWrite = false
    try {
      while (true) {
        try {
          await this.persist(key, next)
        } catch (error) {
          if (repairingStaleWrite) {
            // Why: retain the latest value/tombstone until transient native
            // failures stop; otherwise a stale write becomes durable.
            this.scheduleRepair(key, state)
          }
          throw error
        }
        if (generation === state.generation) {
          if (desired && state.tombstoneGeneration > requestedGeneration) {
            // Why: convergence repairs storage, but the superseded caller must
            // not publish metadata after a deletion won the operation race.
            throw new Error('secure value was deleted')
          }
          return
        }
        generation = state.generation
        next = state.desired
        repairingStaleWrite = true
      }
    } finally {
      state.inFlight -= 1
      this.releaseStateIfSettled(key, state)
    }
  }

  private scheduleRepair(key: string, state: WriteState): void {
    if (state.retryTimer || state.repairing || this.states.get(key) !== state) {
      return
    }
    state.retryTimer = this.setTimer(() => {
      state.retryTimer = null
      void this.repairLatest(key, state)
    }, state.retryDelayMs)
    state.retryDelayMs = Math.min(60_000, state.retryDelayMs * 2)
  }

  private async repairLatest(key: string, state: WriteState): Promise<void> {
    if (state.repairing || this.states.get(key) !== state) {
      return
    }
    state.repairing = true
    let retry = false
    try {
      while (true) {
        const generation = state.generation
        await this.persist(key, state.desired)
        if (generation === state.generation) {
          state.retryDelayMs = 1_000
          return
        }
      }
    } catch {
      retry = true
    } finally {
      state.repairing = false
      if (retry) {
        this.scheduleRepair(key, state)
      }
      this.releaseStateIfSettled(key, state)
    }
  }

  private releaseStateIfSettled(key: string, state: WriteState): void {
    if (
      state.inFlight === 0 &&
      !state.repairing &&
      !state.retryTimer &&
      !state.tombstoned &&
      this.states.get(key) === state
    ) {
      this.states.delete(key)
    }
  }

  resetForTests(): void {
    for (const state of this.states.values()) {
      if (state.retryTimer) {
        this.clearTimer(state.retryTimer)
      }
    }
    this.states.clear()
  }
}
