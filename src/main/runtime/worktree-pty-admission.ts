type WorktreePtyAdmissionState = {
  activeSpawns: number
  teardownOwners: number
  drainWaiters: Set<() => void>
}

export const WORKTREE_PTY_SPAWN_DRAIN_TIMEOUT_MS = 30_000

export class WorktreePtyAdmission {
  private readonly states = new Map<string, WorktreePtyAdmissionState>()

  beginSpawn(worktreeId: string): () => void {
    // Why: the lease spans provider creation through runtime registration, so
    // deletion can drain every PTY that could become visible after its snapshot.
    const state = this.getOrCreate(worktreeId)
    if (state.teardownOwners > 0) {
      throw new Error(`Worktree teardown is in progress: ${worktreeId}`)
    }
    state.activeSpawns += 1
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      state.activeSpawns -= 1
      if (state.activeSpawns === 0) {
        for (const resolve of state.drainWaiters) {
          resolve()
        }
        state.drainWaiters.clear()
      }
      this.deleteIfIdle(worktreeId, state)
    }
  }

  async runTeardown<T>(worktreeId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.closeForTeardown(worktreeId)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async closeForTeardown(worktreeId: string): Promise<() => void> {
    const state = this.getOrCreate(worktreeId)
    if (state.teardownOwners > 0) {
      // Why: teardown-only callers and mismatched remove/forget operations do
      // not join the shared removal promise; never queue their stale state.
      throw new Error(`Worktree teardown is already in progress: ${worktreeId}`)
    }
    state.teardownOwners += 1
    if (state.activeSpawns > 0) {
      let resolveDrain = (): void => {}
      let timer: NodeJS.Timeout | undefined
      const drain = new Promise<void>((resolve) => {
        resolveDrain = resolve
        state.drainWaiters.add(resolve)
      })
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out draining PTY spawns: ${worktreeId}`)),
          WORKTREE_PTY_SPAWN_DRAIN_TIMEOUT_MS
        )
      })
      try {
        await Promise.race([drain, timeout])
      } catch (error) {
        // Why: deletion failed before touching Git. Reopen admission so the
        // still-running spawn can finish in the worktree that remains.
        state.drainWaiters.delete(resolveDrain)
        state.teardownOwners -= 1
        this.deleteIfIdle(worktreeId, state)
        throw error
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      state.teardownOwners -= 1
      this.deleteIfIdle(worktreeId, state)
    }
  }

  private getOrCreate(worktreeId: string): WorktreePtyAdmissionState {
    const existing = this.states.get(worktreeId)
    if (existing) {
      return existing
    }
    const state: WorktreePtyAdmissionState = {
      activeSpawns: 0,
      teardownOwners: 0,
      drainWaiters: new Set()
    }
    this.states.set(worktreeId, state)
    return state
  }

  private deleteIfIdle(worktreeId: string, state: WorktreePtyAdmissionState): void {
    if (state.activeSpawns === 0 && state.teardownOwners === 0) {
      this.states.delete(worktreeId)
    }
  }
}
