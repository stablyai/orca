// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { StepEditor } from '../StepEditor'
import type { WorkflowStep } from '../../../../../shared/workflow-types'

// Same stand-in pattern as ModelSelector.test.tsx — radix Select's portal/pointer
// behavior isn't reliably testable in happy-dom, so mock it down to plain markup
// that still carries the props under test (value, and SelectItem's value/children).
vi.mock('../../ui/select', () => ({
  Select: ({ value, children }: { value: string; children: ReactNode }) => (
    <div data-testid="mock-select" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  )
}))

describe('StepEditor', () => {
  const baseStep: WorkflowStep = {
    id: 's1',
    name: 'Step 1',
    type: 'agent',
    serverSpec: 'project:current',
    config: { type: 'agent', prompt: '', worktreePath: '.' },
    dependsOn: [],
    continueOnError: false,
    timeout: 1800
  }

  beforeEach(() => cleanup())

  // FE-TASK-004: WorkflowStepType renamed 'notify' → 'notification' to match backend
  // StepType (agent|shell|notification|webhook|condition); 'approval' kept pending
  // product confirmation (see FE-TASK-004's task doc) — not in the removed set.
  it('dropdown Type shows agent, shell, notification, webhook, condition, approval — no "notify"', () => {
    render(
      <StepEditor step={baseStep} allSteps={[baseStep]} onUpdate={vi.fn()} onDelete={vi.fn()} />
    )
    for (const t of ['agent', 'shell', 'notification', 'webhook', 'condition', 'approval']) {
      expect(screen.getByTestId(`select-item-${t}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('select-item-notify')).not.toBeInTheDocument()
  })

  it("step.type='notification' → Select receives value='notification' (not the old 'notify')", () => {
    const step: WorkflowStep = { ...baseStep, type: 'notification' }
    render(<StepEditor step={step} allSteps={[step]} onUpdate={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('mock-select')).toHaveAttribute('data-value', 'notification')
  })

  it('renders step name and Delete button calls onDelete', () => {
    const onDelete = vi.fn()
    render(
      <StepEditor step={baseStep} allSteps={[baseStep]} onUpdate={vi.fn()} onDelete={onDelete} />
    )
    expect(screen.getByDisplayValue('Step 1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Delete'))
    expect(onDelete).toHaveBeenCalled()
  })
})
