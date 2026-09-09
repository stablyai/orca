import { useWorkflowExecution } from '../../hooks/useWorkflowExecution'
import { StepStatusBadge } from './StepStatusBadge'
import { Button } from '../ui/button'
import type { WorkflowStep, StepStatus } from '@shared/workflow-types'

export function ExecutionMonitor({ executionId }: { executionId: string }) {
  const {
    execution,
    stepStatuses,
    streamingOutput,
    cancelExecution,
    pauseExecution,
    resumeExecution
  } = useWorkflowExecution(executionId)

  if (!execution) {
    return <div className="p-4 text-sm text-muted-foreground">Loading execution...</div>
  }

  // Group steps by wave
  const waves = groupStepsByWave(execution.definition.steps ?? [], stepStatuses)

  return (
    <div className="execution-monitor p-4 space-y-4" data-testid="execution-monitor">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{execution.definition.name}</div>
          <div className="text-xs text-muted-foreground">
            Started {new Date(execution.startedAt).toLocaleString()} by {execution.triggeredBy}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {execution.rootTraceId && (
            <button
              className="text-[10px] font-mono text-muted-foreground hover:text-foreground"
              title="Copy trace ID — paste into TracePanel filter (Ctrl+Shift+T) to see all steps"
              onClick={() => navigator.clipboard.writeText(execution.rootTraceId!)}
              data-testid="root-trace-id-badge"
            >
              trace:{execution.rootTraceId}
            </button>
          )}
          <StepStatusBadge status={execution.status} />
          {execution.status === 'running' && (
            <Button size="sm" variant="outline" onClick={pauseExecution} data-testid="pause-btn">
              Pause
            </Button>
          )}
          {execution.status === 'paused' && (
            <Button size="sm" variant="outline" onClick={resumeExecution} data-testid="resume-btn">
              Resume
            </Button>
          )}
          {execution.status === 'running' && (
            <Button size="sm" variant="outline" onClick={cancelExecution} data-testid="cancel-btn">
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Waves */}
      {waves.map(({ waveIdx, steps }) => (
        <div key={waveIdx} className="wave-group">
          <div className="text-xs text-muted-foreground mb-2">
            Wave {waveIdx} {steps.length > 1 ? `(${steps.length} parallel)` : ''}
          </div>
          {steps.map(({ step, status }) => (
            <div
              key={step.id}
              className="step-monitor-row border rounded p-2 mb-1"
              data-testid={`step-row-${step.id}`}
            >
              <div className="flex items-center gap-2">
                <StepStatusBadge status={status} />
                <span className="text-sm font-medium">{step.name}</span>
              </div>
              {status === 'running' && (streamingOutput[executionId] ?? []).length > 0 && (
                <pre className="mt-2 text-xs font-mono bg-muted/50 p-2 rounded max-h-32 overflow-y-auto">
                  {(streamingOutput[executionId] ?? []).slice(-50).join('\n')}
                </pre>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// --- Helpers ---

function groupStepsByWave(steps: WorkflowStep[], statuses: Record<string, StepStatus>) {
  const waveMap = new Map<number, { step: WorkflowStep; status: StepStatus }[]>()

  steps.forEach((step) => {
    const wave = calculateWave(step, steps)
    if (!waveMap.has(wave)) {
      waveMap.set(wave, [])
    }
    waveMap.get(wave)!.push({ step, status: statuses[step.id] ?? 'pending' })
  })

  return [...waveMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([waveIdx, steps]) => ({ waveIdx, steps }))
}

function calculateWave(step: WorkflowStep, allSteps: WorkflowStep[]): number {
  if (!step.dependsOn || step.dependsOn.length === 0) {
    return 0
  }
  return Math.max(
    ...step.dependsOn.map((depId) => {
      const dep = allSteps.find((s) => s.id === depId)
      return dep ? calculateWave(dep, allSteps) + 1 : 0
    })
  )
}
