// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ExecutionMonitor } from '../ExecutionMonitor'
import { useWorkflowExecution } from '../../../hooks/useWorkflowExecution'

vi.mock('../../../hooks/useWorkflowExecution', () => ({
  useWorkflowExecution: vi.fn()
}))

describe('ExecutionMonitor', () => {
  const cancelExecution = vi.fn()
  const pauseExecution = vi.fn()
  const resumeExecution = vi.fn()
  const execution = {
    id: 'e1',
    status: 'running',
    startedAt: new Date('2026-07-30T10:00:00Z').toISOString(),
    triggeredBy: 'user',
    definition: {
      name: 'Test Exec',
      steps: [
        { id: 's1', name: 'Step 1', type: 'shell', dependsOn: [] },
        { id: 's2', name: 'Step 2', type: 'shell', dependsOn: ['s1'] }
      ]
    }
  }

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution,
      stepStatuses: { s1: 'completed', s2: 'running' },
      streamingOutput: { e1: ['Log line 1', 'Log line 2'] },
      cancelExecution,
      pauseExecution,
      resumeExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
  })

  it('renders step list from execution object', () => {
    render(<ExecutionMonitor executionId="e1" />)
    expect(screen.getByText('Test Exec')).toBeInTheDocument()
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByText('Step 2')).toBeInTheDocument()
  })

  it('step status=running → shows spinner icon', () => {
    render(<ExecutionMonitor executionId="e1" />)
    const s2Row = screen.getByTestId('step-row-s2')
    expect(s2Row.querySelector('.animate-spin')).toBeInTheDocument()
    expect(s2Row).toHaveTextContent('Running')
  })

  it('step status=completed → shows completed label', () => {
    render(<ExecutionMonitor executionId="e1" />)
    const s1Row = screen.getByTestId('step-row-s1')
    expect(s1Row).toHaveTextContent('Completed')
  })

  it('step status=failed → shows failed label', () => {
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution,
      stepStatuses: { s1: 'failed', s2: 'pending' },
      streamingOutput: {},
      cancelExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
    render(<ExecutionMonitor executionId="e1" />)
    const s1Row = screen.getByTestId('step-row-s1')
    expect(s1Row).toHaveTextContent('Failed')
  })

  it('Cancel button calls cancelExecution', () => {
    render(<ExecutionMonitor executionId="e1" />)
    fireEvent.click(screen.getByTestId('cancel-btn'))
    expect(cancelExecution).toHaveBeenCalled()
  })

  // FE-TASK-003: status='running' → Pause button shown (not Resume); Cancel still shown.
  it("execution.status='running' → Pause button shown, Resume not shown", () => {
    render(<ExecutionMonitor executionId="e1" />)
    expect(screen.getByTestId('pause-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-btn')).not.toBeInTheDocument()
  })

  it("execution.status='paused' → Resume button shown, Pause and Cancel not shown", () => {
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution: { ...execution, status: 'paused' },
      stepStatuses: { s1: 'completed', s2: 'running' },
      streamingOutput: {},
      cancelExecution,
      pauseExecution,
      resumeExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
    render(<ExecutionMonitor executionId="e1" />)
    expect(screen.getByTestId('resume-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('pause-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cancel-btn')).not.toBeInTheDocument()
  })

  it('Pause button calls pauseExecution from the hook', () => {
    render(<ExecutionMonitor executionId="e1" />)
    fireEvent.click(screen.getByTestId('pause-btn'))
    expect(pauseExecution).toHaveBeenCalled()
  })

  it('Resume button calls resumeExecution from the hook', () => {
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution: { ...execution, status: 'paused' },
      stepStatuses: {},
      streamingOutput: {},
      cancelExecution,
      pauseExecution,
      resumeExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
    render(<ExecutionMonitor executionId="e1" />)
    fireEvent.click(screen.getByTestId('resume-btn'))
    expect(resumeExecution).toHaveBeenCalled()
  })

  it('rootTraceId present → shows copyable badge, click copies to clipboard', () => {
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution: { ...execution, rootTraceId: 'trace-root-123' },
      stepStatuses: { s1: 'completed', s2: 'running' },
      streamingOutput: {},
      cancelExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<ExecutionMonitor executionId="e1" />)
    const badge = screen.getByTestId('root-trace-id-badge')
    expect(badge).toHaveTextContent('trace:trace-root-123')

    fireEvent.click(badge)
    expect(writeText).toHaveBeenCalledWith('trace-root-123')
  })

  it('rootTraceId undefined → badge not rendered', () => {
    render(<ExecutionMonitor executionId="e1" />)
    expect(screen.queryByTestId('root-trace-id-badge')).not.toBeInTheDocument()
  })

  // CR-PW-004 regression: execution.status can be 'cancelled' (WorkflowExecutionStatus),
  // which StepStatusBadge's old status map (keyed only on StepStatus) didn't handle —
  // rendering here used to throw before the fix.
  it("execution.status='cancelled' → header badge renders without crashing", () => {
    vi.mocked(useWorkflowExecution).mockReturnValue({
      execution: { ...execution, status: 'cancelled' },
      stepStatuses: { s1: 'completed', s2: 'skipped' },
      streamingOutput: {},
      cancelExecution
    } as unknown as ReturnType<typeof useWorkflowExecution>)
    expect(() => render(<ExecutionMonitor executionId="e1" />)).not.toThrow()
    expect(screen.getAllByText('Cancelled')[0]).toBeInTheDocument()
    // A cancelled execution is no longer running — no Cancel button.
    expect(screen.queryByTestId('cancel-btn')).not.toBeInTheDocument()
  })
})
