// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { WorkflowMonitor } from '../WorkflowMonitor'
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'

vi.mock('../../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn().mockReturnValue('mock-target')
}))

vi.mock('../ExecutionMonitor', () => ({
  ExecutionMonitor: ({ executionId }: { executionId: string }) => (
    <div data-testid="execution-monitor" data-execution-id={executionId} />
  )
}))

type MockStore = {
  executions: unknown[]
  setExecutions: (e: unknown[]) => void
  settings: Record<string, never>
}

const mockStore: MockStore = {
  executions: [],
  setExecutions: vi.fn((e: unknown[]) => {
    mockStore.executions = e
  }),
  settings: {}
}

vi.mock('../../../store', () => ({
  useAppStore: Object.assign(
    (fn?: (store: MockStore) => unknown) => (fn ? fn(mockStore) : mockStore),
    { getState: () => mockStore }
  )
}))

const mockRpc = vi.mocked(callRuntimeRpc)

describe('WorkflowMonitor (CR-PW-003)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockStore.executions = []
    mockRpc.mockResolvedValue([])
  })

  it('fetches workflow.listExecutions(projectId) on mount', async () => {
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={vi.fn()} />)
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mock-target', 'workflow.listExecutions', {
        projectId: 'p1'
      })
    })
  })

  it('shows the empty state when there are no executions', async () => {
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('workflow-empty')).toBeInTheDocument()
    })
  })

  it('shows an error state when the RPC throws', async () => {
    mockRpc.mockRejectedValueOnce(new Error('boom'))
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('workflow-load-error')).toBeInTheDocument()
    })
  })

  it('"+ New Workflow" button calls onNewWorkflow', async () => {
    const onNewWorkflow = vi.fn()
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={onNewWorkflow} />)
    await waitFor(() => screen.getByTestId('new-workflow-btn'))
    fireEvent.click(screen.getByTestId('new-workflow-btn'))
    expect(onNewWorkflow).toHaveBeenCalled()
  })

  it('renders one row per execution with its status and triggeredBy', async () => {
    mockRpc.mockResolvedValueOnce([
      {
        id: 'exec-1',
        status: 'running',
        triggeredBy: 'user-1',
        definition: { name: 'Deploy', steps: [] }
      }
    ])
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('execution-row-exec-1')).toHaveTextContent('Deploy')
      expect(screen.getByTestId('execution-row-exec-1')).toHaveTextContent('Running')
      expect(screen.getByTestId('execution-row-exec-1')).toHaveTextContent('user-1')
    })
  })

  it('clicking an execution row opens ExecutionMonitor, with a way back to the list', async () => {
    mockRpc.mockResolvedValueOnce([
      {
        id: 'exec-1',
        status: 'completed',
        triggeredBy: 'user-1',
        definition: { name: 'Deploy', steps: [] }
      }
    ])
    render(<WorkflowMonitor projectId="p1" onNewWorkflow={vi.fn()} />)
    await waitFor(() => screen.getByTestId('execution-row-exec-1'))
    fireEvent.click(screen.getByTestId('execution-row-exec-1'))

    expect(screen.getByTestId('execution-monitor')).toHaveAttribute('data-execution-id', 'exec-1')

    fireEvent.click(screen.getByTestId('workflow-back-to-list'))
    await waitFor(() => {
      expect(screen.getByTestId('execution-row-exec-1')).toBeInTheDocument()
    })
  })
})
