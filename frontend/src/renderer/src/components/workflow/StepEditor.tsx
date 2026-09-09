import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type {
  WorkflowStep,
  WorkflowStepType,
  AgentStepConfig
} from '../../../../shared/workflow-types'

type StepEditorProps = {
  step: WorkflowStep
  allSteps: WorkflowStep[]
  onUpdate: (patch: Partial<WorkflowStep>) => void
  onDelete: () => void
}

export function StepEditor({ step, allSteps, onUpdate, onDelete }: StepEditorProps) {
  return (
    <div className="step-editor space-y-3" data-testid="step-editor">
      <div className="flex items-center justify-between">
        <Input
          value={step.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="font-medium"
        />
        <Button size="sm" variant="ghost" className="text-red-600" onClick={onDelete}>
          Delete
        </Button>
      </div>
      <div>
        <Label>Type</Label>
        <Select value={step.type} onValueChange={(t) => onUpdate({ type: t as WorkflowStepType })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 'approval' kept until product confirms removal — see FE-TASK-004. */}
            {['agent', 'shell', 'notification', 'webhook', 'condition', 'approval'].map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {step.type === 'agent' && (
        <div>
          <Label>Prompt</Label>
          <textarea
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring mt-1"
            value={(step.config as AgentStepConfig).prompt ?? ''}
            onChange={(e) =>
              onUpdate({ config: { ...(step.config as AgentStepConfig), prompt: e.target.value } })
            }
            rows={4}
          />
        </div>
      )}
      <div>
        <Label>Depends On</Label>
        {allSteps
          .filter((s) => s.id !== step.id)
          .map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={step.dependsOn.includes(s.id)}
                onChange={(e) =>
                  onUpdate({
                    dependsOn: e.target.checked
                      ? [...step.dependsOn, s.id]
                      : step.dependsOn.filter((d) => d !== s.id)
                  })
                }
              />
              {s.name}
            </label>
          ))}
      </div>
    </div>
  )
}
