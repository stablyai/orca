/** Where a workspace's recipe VM stands for a client about to reach its server. */
export type RecipeVmState = 'up' | 'waking' | 'asleep'

export type VmOperation =
  | { kind: 'wake'; settled: Promise<unknown> }
  | { kind: 'suspend'; suspending: boolean }

/** Where the VM stands, from its pending operations (in the order asked for), which outrank its
 *  stored record: a wake still reconnecting has already marked it running, and a running suspend
 *  has not yet marked it suspended. A suspend still waiting its turn leaves the server as it is. */
export function vmStateOf(
  pending: readonly VmOperation[],
  recordSuspended: boolean
): RecipeVmState {
  const lastWake = pending.findLastIndex((operation) => operation.kind === 'wake')
  const lastSuspending = pending.findLastIndex(
    (operation) => operation.kind === 'suspend' && operation.suspending
  )
  if (lastSuspending > lastWake) {
    return 'asleep'
  }
  if (lastWake !== -1) {
    return 'waking'
  }
  return recordSuspended ? 'asleep' : 'up'
}

/** Settles with the latest pending wake (rejecting if it fails). */
export async function pendingVmWake(pending: readonly VmOperation[]): Promise<void> {
  const wake = pending.findLast((operation) => operation.kind === 'wake')
  if (wake?.kind === 'wake') {
    await wake.settled
  }
}

/** Keeps an operation in its workspace's pending list until it settles. */
export function trackPendingVmOperation<T>(
  pendingByWorkspace: Map<string, VmOperation[]>,
  worktreeId: string,
  operation: VmOperation,
  run: Promise<T>
): Promise<T> {
  pendingByWorkspace.set(worktreeId, [...(pendingByWorkspace.get(worktreeId) ?? []), operation])
  return run.finally(() => {
    const left = (pendingByWorkspace.get(worktreeId) ?? []).filter(
      (pending) => pending !== operation
    )
    if (left.length > 0) {
      pendingByWorkspace.set(worktreeId, left)
    } else {
      pendingByWorkspace.delete(worktreeId)
    }
  })
}

/** How a held open of a recipe VM workspace ended: the VM is up, a Sleep asked for after the
 *  open won, the wake is still running when the hold ran out, or the wake failed. */
export type RecipeVmOpening = 'up' | 'slept' | 'waking' | 'wake-failed'

/** Sleeps asked for per workspace, so an open held for a wake learns that a later Sleep won. */
export class WorkspaceSleepRequests {
  private readonly listeners = new Map<string, Set<() => void>>()

  noteRequested(worktreeId: string): void {
    for (const listener of this.listeners.get(worktreeId) ?? []) {
      listener()
    }
  }

  /** Resolves when the next sleep of this workspace is asked for; `stop` stops listening. */
  next(worktreeId: string): { requested: Promise<void>; stop: () => void } {
    const listeners = this.listeners.get(worktreeId) ?? new Set<() => void>()
    this.listeners.set(worktreeId, listeners)
    let listener: () => void = () => {}
    const requested = new Promise<void>((resolve) => {
      listener = resolve
    })
    listeners.add(listener)
    return {
      requested,
      stop: () => {
        listeners.delete(listener)
        if (listeners.size === 0 && this.listeners.get(worktreeId) === listeners) {
          this.listeners.delete(worktreeId)
        }
      }
    }
  }
}

/** Holds an open until its wake settles, a later Sleep wins, or the hold runs out. */
export async function holdOpenUntilUp(
  wake: Promise<unknown>,
  sleepRequested: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RecipeVmOpening> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopAbortWatch = (): void => {}
  const outcomes: Promise<RecipeVmOpening>[] = [
    wake.then(
      (): RecipeVmOpening => 'up',
      (error: unknown): RecipeVmOpening => {
        console.warn('[workspace-sleep] recipe VM wake failed', error)
        return 'wake-failed'
      }
    ),
    sleepRequested.then((): RecipeVmOpening => 'slept'),
    new Promise<RecipeVmOpening>((resolve) => {
      timer = setTimeout(() => resolve('waking'), timeoutMs)
    }),
    // A caller that gave up frees its place; the wake itself goes on.
    new Promise<RecipeVmOpening>((_resolve, reject) => {
      const abort = (): void => reject(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      stopAbortWatch = () => signal?.removeEventListener('abort', abort)
    })
  ]
  try {
    return await Promise.race(outcomes)
  } finally {
    clearTimeout(timer)
    stopAbortWatch()
  }
}
