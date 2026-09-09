import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { OrcaTask } from '../../../shared/task-types'

// Same interval constant style as useWorkflowExecution.ts's EXECUTION_POLL_INTERVAL_MS —
// keep the two polling hooks consistent rather than inventing a second value.
const TASK_ACTIVITY_POLL_INTERVAL_MS = 4_000

// Polling fallback for post-Run task status: `subscribeRuntimeEvent(target, 'task.activity:
// ${taskId}', cb)` (CR-FLOW-TASK-005's original design) doesn't exist anywhere in the
// codebase, and the one real push-event client (subscribeRuntimeClientEvents) only takes an
// environmentId (no 'local' target) and a closed event union with no task/workflow variant.
// Both the backend WS channel (CR-FLOW-TASK-003) and that client-side variant are still
// unbuilt — polling `task.get` is a real, working, cross-platform stopgap until they land.
export function useTaskActivity(taskId: string | null | undefined) {
  const [task, setTask] = useState<OrcaTask | null>(null)
  // Always false today — flips meaningful once a real push channel replaces this poll, so UI
  // can distinguish "polling" from "live" without a call-site change later.
  const [isLive] = useState(false)

  useEffect(() => {
    if (!taskId) {
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const target = getActiveRuntimeTarget(useAppStore.getState().settings)
        // channels.go:299-312 decodes {id}, not {taskId} — the flow-task v3 solution doc this
        // hook is copied from used {taskId} and would silently 404 against the real backend.
        const result = await callRuntimeRpc<OrcaTask>(target, 'task.get', { id: taskId })
        if (!cancelled) {
          setTask(result)
        }
      } catch {
        // Transient RPC failure — next tick retries; no error state for a background poll.
      }
    }
    void poll() // poll immediately on mount, don't wait for the first interval tick
    const intervalId = setInterval(() => {
      void poll()
    }, TASK_ACTIVITY_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [taskId])

  return { task, isLive }
}
