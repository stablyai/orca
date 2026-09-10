import type { DispatchContextRow, TaskRow } from './types'

function compareDispatches(left: DispatchContextRow, right: DispatchContextRow): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
}

export function selectCurrentTaskDispatches(
  tasks: readonly TaskRow[],
  dispatches: readonly DispatchContextRow[]
): DispatchContextRow[] {
  const dispatchesByTask = new Map<string, DispatchContextRow[]>()
  for (const dispatch of dispatches) {
    const candidates = dispatchesByTask.get(dispatch.task_id) ?? []
    candidates.push(dispatch)
    dispatchesByTask.set(dispatch.task_id, candidates)
  }

  return tasks.flatMap((task) => {
    const candidates = dispatchesByTask.get(task.id) ?? []
    const retriedDispatchIds = new Set(
      candidates.flatMap((dispatch) =>
        dispatch.retry_of_dispatch_id ? [dispatch.retry_of_dispatch_id] : []
      )
    )
    const leaves = candidates.filter((dispatch) => !retriedDispatchIds.has(dispatch.id))
    const current = leaves.sort(compareDispatches).at(-1)
    return current ? [current] : []
  })
}
