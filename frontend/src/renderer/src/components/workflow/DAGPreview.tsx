import { useMemo } from 'react'
import { ReactFlow, type Node, type Edge, Background, Controls } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { WorkflowStep } from '@shared/workflow-types'

type DAGPreviewProps = {
  steps: WorkflowStep[]
  selectedStepId?: string | null
}

const STEP_TYPE_COLORS: Record<string, string> = {
  shell: '#dbeafe', // blue
  agent: '#fce7f3', // pink
  code: '#f0fdf4', // green
  review: '#fef9c3', // yellow
  default: '#f8fafc' // grey
}

function buildWorkflowDAG(steps: WorkflowStep[], selectedStepId?: string | null) {
  const nodes: Node[] = []
  const edges: Edge[] = []

  // Assign wave (topological level)
  const waveMap = new Map<string, number>()
  const depMap = new Map(steps.map((s) => [s.id, s.dependsOn ?? []]))

  function getWave(id: string, visited = new Set<string>()): number {
    if (waveMap.has(id)) {
      return waveMap.get(id)!
    }
    if (visited.has(id)) {
      return 0
    }
    visited.add(id)
    const deps = depMap.get(id) ?? []
    const wave =
      deps.length === 0 ? 0 : Math.max(...deps.map((d) => getWave(d, new Set(visited)))) + 1
    waveMap.set(id, wave)
    return wave
  }
  steps.forEach((s) => getWave(s.id))

  // Group by wave
  const waveGroups = new Map<number, WorkflowStep[]>()
  for (const step of steps) {
    const w = waveMap.get(step.id) ?? 0
    if (!waveGroups.has(w)) {
      waveGroups.set(w, [])
    }
    waveGroups.get(w)!.push(step)
  }

  // Create nodes
  for (const [wave, waveSteps] of waveGroups) {
    waveSteps.forEach((step, idx) => {
      const isSelected = step.id === selectedStepId
      const bg = STEP_TYPE_COLORS[step.type] ?? STEP_TYPE_COLORS.default
      nodes.push({
        id: step.id,
        position: { x: wave * 200, y: idx * 80 },
        data: {
          label: (
            <div style={{ fontSize: 11 }}>
              <div
                style={{
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 130
                }}
              >
                {step.name}
              </div>
              <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{step.type}</div>
            </div>
          )
        },
        style: {
          background: bg,
          border: isSelected ? '2px solid #3b82f6' : '1px solid #e2e8f0',
          borderRadius: 8,
          width: 160,
          boxShadow: isSelected ? '0 0 0 2px #bfdbfe' : 'none'
        }
      })
    })
  }

  // Create edges
  for (const step of steps) {
    for (const depId of step.dependsOn ?? []) {
      if (steps.find((s) => s.id === depId)) {
        edges.push({
          id: `${depId}->${step.id}`,
          source: depId,
          target: step.id,
          animated: false,
          style: { stroke: '#94a3b8', strokeWidth: 1.5 }
        })
      }
    }
  }

  return { nodes, edges }
}

export function DAGPreview({ steps, selectedStepId }: DAGPreviewProps) {
  const { nodes, edges } = useMemo(
    () => buildWorkflowDAG(steps, selectedStepId),
    [steps, selectedStepId]
  )

  if (steps.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-full text-xs text-muted-foreground"
        data-testid="dag-preview-empty"
      >
        Add steps to see the DAG
      </div>
    )
  }

  return (
    <div className="dag-preview h-full min-h-[150px]" data-testid="dag-preview">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={12} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
