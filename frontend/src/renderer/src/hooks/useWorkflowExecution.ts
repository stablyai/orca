import { useEffect, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { Tracers } from '../../../shared/trace/tracers'
import { toast } from 'sonner'
import type { WorkflowExecution } from '@shared/workflow-types'

// How often to re-poll `workflow.getExecution` while an execution is running.
const EXECUTION_POLL_INTERVAL_MS = 4_000

// CR-PW-006 (interim, pre-Phase-D — see docs/crs/v3/project-workspace/CR-PW-006):
// this used to subscribe to `window.api.on('workflow:stepStatus' | 'workflow:stepOutput'
// | 'workflow:complete', ...)`, an Electron-only bridge. In Web mode, `window.api` is a
// Proxy (web-preload-api.ts's withFallback/createFallbackProxy) with no real top-level
// `on` key, so `window.api.on` resolved to a truthy fallback stub whose call immediately
// returns a no-op unsubscribe without ever registering the handler — live step-status/
// output/complete events were silently dropped forever in Web mode, with no error.
// There is also no existing generic JSON push-channel client in the frontend to subscribe
// to instead (the terminal multiplexer's push transport is a dedicated binary PTY-frame
// protocol, not reusable here) — building one is Phase D of CR-PW-006, out of scope for
// this pass. Polling `workflow.getExecution` (wired in CR-PW-005) is a real, working,
// cross-platform stopgap; it only reports execution-level `status` today, not per-step
// detail — see CR-PW-006 for the full push-based design.
export function useWorkflowExecution(executionId: string) {
  const { stepStatuses, streamingOutput } = useAppStore((s) => ({
    stepStatuses: s.stepStatuses[executionId] ?? {},
    streamingOutput: s.streamingOutput
  }))
  const execution = useAppStore((s) => s.executions.find((e) => e.id === executionId))
  const executionStatus = execution?.status

  useEffect(() => {
    if (!executionId || executionStatus !== 'running') {
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const target = getActiveRuntimeTarget(useAppStore.getState().settings)
        const result = await callRuntimeRpc<WorkflowExecution>(target, 'workflow.getExecution', {
          executionId
        })
        if (!cancelled) {
          useAppStore.getState().updateExecutionStatus(executionId, result.status)
        }
      } catch {
        // Transient RPC failure — next tick retries; no need to surface an error state
        // for a background poll.
      }
    }
    const intervalId = setInterval(() => {
      void poll()
    }, EXECUTION_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [executionId, executionStatus])

  const cancelExecution = useCallback(async () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const rootTraceId = useAppStore
      .getState()
      .executions.find((e) => e.id === executionId)?.rootTraceId
    // Field `parentTraceId` (không phải resume) nhóm thao tác cancel này vào cùng
    // execution trong TracePanel, dù span này có id riêng.
    const span = Tracers.uiWorkflowCancelFlow.start({ executionId, parentTraceId: rootTraceId })
    try {
      await callRuntimeRpc(target, 'workflow.cancel', { executionId, traceId: span.id })
      useAppStore.getState().updateExecutionStatus(executionId, 'cancelled')
      span.ok({ executionId })
    } catch (err) {
      span.fail(err, { executionId })
      throw err
    }
  }, [executionId])

  const pauseExecution = useCallback(async () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      await callRuntimeRpc(target, 'workflow.pause', { executionId })
      // Optimistic update required — the polling effect above only runs while
      // status==='running', so it won't pick up 'paused' until the next tick
      // (up to EXECUTION_POLL_INTERVAL_MS late) unless we set it here.
      useAppStore.getState().updateExecutionStatus(executionId, 'paused')
    } catch (err) {
      toast.error('Failed to pause workflow')
      throw err
    }
  }, [executionId])

  const resumeExecution = useCallback(async () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      await callRuntimeRpc(target, 'workflow.resume', { executionId })
      // Optimistic update required — polling only (re)starts when status is
      // 'running' (see the effect's guard above); without this the poll never
      // resumes after a pause, since nothing else would flip status back.
      useAppStore.getState().updateExecutionStatus(executionId, 'running')
    } catch (err) {
      toast.error('Failed to resume workflow')
      throw err
    }
  }, [executionId])

  return {
    execution,
    stepStatuses,
    streamingOutput,
    cancelExecution,
    pauseExecution,
    resumeExecution
  }
}
