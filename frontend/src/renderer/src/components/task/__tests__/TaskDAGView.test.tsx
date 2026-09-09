// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskDAGView } from '../TaskDAGView'
import type { OrcaTask } from '../../../../../shared/task-types'
import type { Node, Edge } from '@xyflow/react'

// ReactFlow needs a real DOM size + ResizeObserver to render — mocked the same way
// components/workflow/__tests__/DAGPreview.test.tsx does for the other DAG view in this repo.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => (
    <div data-testid="mock-react-flow">
      <div data-testid="nodes-count">{nodes.length}</div>
      <div data-testid="edges-json">
        {JSON.stringify(edges.map((e) => ({ source: e.source, target: e.target })))}
      </div>
    </div>
  ),
  Background: () => <div />,
  Controls: () => <div />,
  MiniMap: () => <div />
}))

vi.mock('../../../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({ settings: {} }) })
}))

vi.mock('../../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn().mockReturnValue('mock-target')
}))
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'
const mockRpc = vi.mocked(callRuntimeRpc)

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))
import { toast } from 'sonner'
const mockToast = vi.mocked(toast)

function makeTask(overrides: Partial<OrcaTask>): OrcaTask {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Task',
    type: 'task',
    status: 'todo',
    priority: 'medium',
    labels: [],
    visibility: 'private',
    progressPercent: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  }
}

describe('TaskDAGView', () => {
  const onSelect = vi.fn()

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('2 tasks, task.getDependencies returns 1 depends_on edge → edges render exactly that 1 edge', async () => {
    const tasks = [makeTask({ id: 'a', title: 'A' }), makeTask({ id: 'b', title: 'B' })]
    mockRpc.mockImplementation((_target, _method, args) => {
      if ((args as { taskId: string }).taskId === 'b') {
        return Promise.resolve([{ task: { id: 'a' }, edgeType: 'depends_on' }])
      }
      return Promise.resolve([])
    })

    render(<TaskDAGView tasks={tasks} onSelect={onSelect} />)

    await waitFor(() => {
      const edges = JSON.parse(screen.getByTestId('edges-json').textContent!)
      expect(edges).toEqual([{ source: 'a', target: 'b' }])
    })
  })

  it('task.getDependencies fails for one task → DAG still renders nodes, edges for that task are empty', async () => {
    const tasks = [makeTask({ id: 'a', title: 'A' }), makeTask({ id: 'b', title: 'B' })]
    mockRpc.mockImplementation((_target, _method, args) => {
      if ((args as { taskId: string }).taskId === 'b') {
        return Promise.reject(new Error('rpc failed'))
      }
      return Promise.resolve([])
    })

    render(<TaskDAGView tasks={tasks} onSelect={onSelect} />)

    await waitFor(() => {
      expect(screen.getByTestId('nodes-count')).toHaveTextContent('2')
    })
    // The whole Promise.all rejects when any task's fetch rejects — depsById keeps its
    // initial empty Map, so no edges render (not a crash), per the component's .catch().
    expect(JSON.parse(screen.getByTestId('edges-json').textContent!)).toEqual([])
  })

  it('selecting "from" then "to" in the add-dependency dropdowns calls task.addEdge', async () => {
    const tasks = [makeTask({ id: 'a', title: 'A' }), makeTask({ id: 'b', title: 'B' })]
    mockRpc.mockResolvedValue([])

    render(<TaskDAGView tasks={tasks} onSelect={onSelect} />)
    await waitFor(() => expect(screen.getByTestId('nodes-count')).toHaveTextContent('2'))

    mockRpc.mockClear()
    mockRpc.mockResolvedValueOnce(undefined) // task.addEdge

    fireEvent.change(screen.getByTestId('dag-add-dependency-select-from'), {
      target: { value: 'a' }
    })
    fireEvent.change(screen.getByTestId('dag-add-dependency-select-to'), {
      target: { value: 'b' }
    })

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'task.addEdge', {
        fromTaskId: 'a',
        toTaskId: 'b',
        type: 'depends_on'
      })
    })
  })

  it('task.addEdge failure does not crash and leaves addingFor set (select-to stays visible)', async () => {
    const tasks = [makeTask({ id: 'a', title: 'A' }), makeTask({ id: 'b', title: 'B' })]
    mockRpc.mockResolvedValue([])

    render(<TaskDAGView tasks={tasks} onSelect={onSelect} />)
    await waitFor(() => expect(screen.getByTestId('nodes-count')).toHaveTextContent('2'))

    mockRpc.mockClear()
    mockRpc.mockRejectedValueOnce(new Error('cycle detected'))

    fireEvent.change(screen.getByTestId('dag-add-dependency-select-from'), {
      target: { value: 'a' }
    })
    fireEvent.change(screen.getByTestId('dag-add-dependency-select-to'), {
      target: { value: 'b' }
    })

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to add dependency: cycle detected')
    })
    // addingFor was not reset on failure — the "to" dropdown (rendered only while addingFor
    // is set) is still present, letting the user retry.
    expect(screen.getByTestId('dag-add-dependency-select-to')).toBeInTheDocument()
  })
})
