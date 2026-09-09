import { useState, lazy, Suspense } from 'react'
import { useWorkflow } from '../../hooks/useWorkflow'
import { StepList } from './StepList'
import { arrayMove } from '@dnd-kit/sortable'
import { Button } from '../ui/button'

const DAGPreview = lazy(() => import('./DAGPreview').then((m) => ({ default: m.DAGPreview })))
const StepEditor = lazy(() => import('./StepEditor').then((m) => ({ default: m.StepEditor })))

export function WorkflowBuilder({
  templateId,
  projectId,
  onSave
}: {
  templateId?: string
  projectId: string
  onSave?: () => void
}) {
  const { template, addStep, removeStep, updateStep, updateTemplate, saveTemplate, runWorkflow } =
    useWorkflow(templateId)
  const [selectedStepId, setSelectedStep] = useState<string | null>(null)
  const [showDAG, setShowDAG] = useState(false)

  const handleReorder = (from: number, to: number) => {
    const reordered = arrayMove(template.steps ?? [], from, to)
    updateTemplate({ steps: reordered })
  }

  return (
    <div className="workflow-builder flex flex-col h-full" data-testid="workflow-builder">
      {/* Header */}
      <div className="flex items-center gap-2 p-2 border-b">
        <input
          value={template.name ?? ''}
          onChange={(e) => updateTemplate({ name: e.target.value })}
          placeholder="Workflow name..."
          className="flex-1 text-base font-semibold border-0 focus:outline-none bg-transparent"
          data-testid="workflow-name-input"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowDAG((v) => !v)}
          data-testid="toggle-dag-preview"
        >
          {showDAG ? 'Hide DAG' : 'Show DAG'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await saveTemplate()
            onSave?.()
          }}
          data-testid="save-workflow-btn"
        >
          Save
        </Button>
        <Button size="sm" onClick={() => runWorkflow(projectId)} data-testid="run-workflow-btn">
          Run
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Steps panel */}
        <div className="w-52 border-r overflow-y-auto p-2">
          <StepList
            steps={template.steps ?? []}
            selectedStepId={selectedStepId}
            onSelect={setSelectedStep}
            onAdd={() => {
              const id = addStep()
              setSelectedStep(id)
            }}
            onReorder={handleReorder}
          />
        </div>

        {/* Step editor */}
        <div className="flex-1 overflow-auto p-2">
          <Suspense
            fallback={<div className="p-4 text-sm text-muted-foreground">Loading Editor...</div>}
          >
            {selectedStepId && template.steps && (
              <StepEditor
                step={template.steps.find((s) => s.id === selectedStepId)!}
                allSteps={template.steps}
                onUpdate={(patch) => updateStep(selectedStepId, patch)}
                onDelete={() => {
                  removeStep(selectedStepId)
                  setSelectedStep(null)
                }}
              />
            )}
          </Suspense>
        </div>

        {/* DAG preview */}
        {showDAG && (
          <div className="w-72 border-l">
            <Suspense
              fallback={<div className="p-4 text-sm text-muted-foreground">Loading DAG...</div>}
            >
              <DAGPreview steps={template.steps ?? []} selectedStepId={selectedStepId} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}
