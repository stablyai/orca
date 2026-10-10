import { useRef, useState } from 'react'
import { structuredSessionConfirmedStopsStillListed } from '../../../src/shared/structured-session-background-tasks-view'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

export type MobileBackgroundTaskStopping = { taskIds: ReadonlySet<string>; all: boolean }

const NO_TASKS: ReadonlySet<string> = new Set()
const NOT_STOPPING: MobileBackgroundTaskStopping = { taskIds: NO_TASKS, all: false }

/** The strip's Stop presses: which buttons hold, and the press that sends one. */
export function useMobileBackgroundTaskStops(
  tasks: Pick<MobileStructuredBackgroundTasks, 'view' | 'stop'>
): { stopping: MobileBackgroundTaskStopping; onStop: (taskId?: string) => void } {
  const { view, stop } = tasks
  const [stopping, setStopping] = useState<MobileBackgroundTaskStopping>(NOT_STOPPING)
  const stoppingRef = useRef(NOT_STOPPING)
  // Stops the host confirmed: each row keeps its stopping button until it leaves the strip.
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(NO_TASKS)
  const confirmedListed = structuredSessionConfirmedStopsStillListed(view, confirmed)
  if (confirmedListed !== confirmed) {
    // A row that left and came back is a task the Stop did not end, so it offers Stop again.
    setConfirmed(confirmedListed)
  }

  const updateStopping = (next: MobileBackgroundTaskStopping): void => {
    stoppingRef.current = next
    setStopping(next)
  }
  // A press already on its way holds its button; the ref closes the same-frame double tap.
  const onStop = (taskId?: string): void => {
    const current = stoppingRef.current
    if (taskId ? current.taskIds.has(taskId) : current.all) {
      return
    }
    updateStopping({
      taskIds: taskId ? new Set([...current.taskIds, taskId]) : current.taskIds,
      all: taskId ? current.all : true
    })
    void stop(taskId)
      .then((result) => {
        if (taskId && result.status === 'accepted' && result.value.cancelled) {
          setConfirmed((held) => new Set([...held, taskId]))
        }
      })
      .finally(() => {
        const latest = stoppingRef.current
        const taskIds = new Set(latest.taskIds)
        if (taskId) {
          taskIds.delete(taskId)
        }
        updateStopping({ taskIds, all: taskId ? latest.all : false })
      })
  }

  return {
    stopping: confirmedListed.size
      ? { ...stopping, taskIds: new Set([...stopping.taskIds, ...confirmedListed]) }
      : stopping,
    onStop
  }
}
