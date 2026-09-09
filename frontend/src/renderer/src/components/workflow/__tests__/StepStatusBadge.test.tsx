// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { describe, expect, it, afterEach } from 'vitest'
import { StepStatusBadge } from '../StepStatusBadge'

describe('StepStatusBadge', () => {
  afterEach(cleanup)

  it('renders every StepStatus without crashing', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'skipped'] as const) {
      const { unmount } = render(<StepStatusBadge status={status} />)
      unmount()
    }
  })

  // CR-PW-004 regression: WorkflowExecutionStatus includes 'cancelled', which
  // StepStatus does not — ExecutionMonitor.tsx passes execution.status (a
  // WorkflowExecutionStatus) into this component, and the old STEP_STATUS map
  // (keyed only on StepStatus) threw `Cannot destructure property 'icon' of
  // undefined` for 'cancelled'.
  it("renders 'cancelled' (WorkflowExecutionStatus, not in StepStatus) without crashing", () => {
    expect(() => render(<StepStatusBadge status="cancelled" />)).not.toThrow()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  // FE-TASK-003: 'paused' is another WorkflowExecutionStatus value not in StepStatus —
  // same crash class as the 'cancelled' regression above.
  it("renders 'paused' (WorkflowExecutionStatus, not in StepStatus) without crashing", () => {
    expect(() => render(<StepStatusBadge status="paused" />)).not.toThrow()
    expect(screen.getByText('Paused')).toBeInTheDocument()
  })

  it('renders the expected label for each status', () => {
    const cases: [Parameters<typeof StepStatusBadge>[0]['status'], string][] = [
      ['pending', 'Pending'],
      ['running', 'Running'],
      ['completed', 'Completed'],
      ['failed', 'Failed'],
      ['skipped', 'Skipped'],
      ['cancelled', 'Cancelled'],
      ['paused', 'Paused']
    ]
    for (const [status, label] of cases) {
      const { unmount } = render(<StepStatusBadge status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })
})
