import { linearError } from './issue-context-errors'
const reads = new Map<string, Set<AbortController>>()

export function registerLinearAccountRead(workspaceId: string): {
  signal: AbortSignal
  dispose: () => void
  mutateIfCurrent: (mutation: () => void) => boolean
} {
  const controller = new AbortController()
  let active = reads.get(workspaceId)
  if (!active) {
    active = new Set()
    reads.set(workspaceId, active)
  }
  active.add(controller)
  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    active.delete(controller)
    if (active.size === 0 && reads.get(workspaceId) === active) {
      reads.delete(workspaceId)
    }
  }
  return {
    signal: controller.signal,
    dispose,
    mutateIfCurrent: (mutation) => {
      if (disposed || controller.signal.aborted) {
        return false
      }
      dispose()
      mutation()
      return true
    }
  }
}

export function invalidateLinearAccountReads(workspaceId: string): void {
  for (const controller of reads.get(workspaceId) ?? []) {
    controller.abort(
      linearError(
        'linear_list_stale_recovery',
        'Linear account changed during the read; restart and reconcile.'
      )
    )
  }
}
