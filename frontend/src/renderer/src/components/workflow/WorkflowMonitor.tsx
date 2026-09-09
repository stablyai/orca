// WorkflowMonitor.tsx — lists this project's workflow executions (CR-PW-003 fix; was a static
// stub, see git blame). Reuses ExecutionMonitor for the detail view instead of re-building
// step/wave tracking.
import { useCallback, useEffect, useState } from 'react'
import { ExecutionMonitor } from './ExecutionMonitor'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import type { WorkflowExecution, WorkflowExecutionStatus } from '@shared/workflow-types'

// Why not StepStatusBadge: it only maps StepStatus (pending/running/completed/failed/skipped),
// not WorkflowExecutionStatus (which also has 'cancelled') — reusing it here would destructure
// undefined and crash on a cancelled execution (ExecutionMonitor.tsx casts around the same
// mismatch with `as any`). A small inline map avoids repeating that latent bug in new code.
const STATUS_LABEL: Record<WorkflowExecutionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

export function WorkflowMonitor({
  projectId,
  onNewWorkflow,
  onOpenLibrary
}: {
  projectId: string
  onNewWorkflow: () => void
  onOpenLibrary?: () => void
}) {
  const executions = useAppStore((s) => s.executions)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadError(false)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const result = await callRuntimeRpc<WorkflowExecution[]>(target, 'workflow.listExecutions', {
        projectId
      })
      useAppStore.getState().setExecutions(result)
    } catch {
      setLoadError(true)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  if (selectedExecutionId) {
    return (
      <div className="workflow-monitor" data-testid="workflow-monitor">
        <button
          className="text-xs text-muted-foreground hover:text-foreground px-4 pt-3"
          onClick={() => setSelectedExecutionId(null)}
          data-testid="workflow-back-to-list"
        >
          &larr; Back to executions
        </button>
        <ExecutionMonitor executionId={selectedExecutionId} />
      </div>
    )
  }

  return (
    <div className="workflow-monitor p-4 space-y-2" data-testid="workflow-monitor">
      <div className="flex justify-end gap-2">
        {onOpenLibrary && (
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenLibrary}
            data-testid="open-library-btn"
          >
            Browse Library
          </Button>
        )}
        <Button size="sm" onClick={onNewWorkflow} data-testid="new-workflow-btn">
          + New Workflow
        </Button>
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground" data-testid="workflow-loading">
          Loading executions&hellip;
        </div>
      ) : loadError ? (
        <div className="text-xs text-destructive" data-testid="workflow-load-error">
          Failed to load workflow executions.
        </div>
      ) : executions.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="workflow-empty">
          No workflow executions for this project yet.
        </div>
      ) : (
        executions.map((execution) => (
          <button
            key={execution.id}
            className="execution-row w-full text-left border rounded p-2 hover:bg-accent flex items-center justify-between"
            onClick={() => setSelectedExecutionId(execution.id)}
            data-testid={`execution-row-${execution.id}`}
          >
            <span className="text-sm font-medium">
              {execution.definition?.name ?? execution.id}
            </span>
            <span className="text-xs text-muted-foreground">
              {STATUS_LABEL[execution.status]} &middot; {execution.triggeredBy}
            </span>
          </button>
        ))
      )}
    </div>
  )
}
