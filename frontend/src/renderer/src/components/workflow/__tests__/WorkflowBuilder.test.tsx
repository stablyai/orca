// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { WorkflowBuilder } from '../WorkflowBuilder'
import { useWorkflow } from '../../../hooks/useWorkflow'

vi.mock('../../../hooks/useWorkflow', () => ({
  useWorkflow: vi.fn()
}))

// Mock components
vi.mock('../StepList', () => ({
  StepList: ({ onSelect, onAdd }: { onSelect: (id: string) => void; onAdd: () => void }) => (
    <div data-testid="mock-step-list">
      <button data-testid="add-step" onClick={() => onAdd()}>
        Add Step
      </button>
      <button data-testid="select-s1" onClick={() => onSelect('s1')}>
        Select s1
      </button>
    </div>
  )
}))

vi.mock('../StepEditor', () => ({
  StepEditor: () => <div data-testid="mock-step-editor">Editor</div>
}))

vi.mock('../DAGPreview', () => ({
  DAGPreview: () => <div data-testid="mock-dag-preview">DAG</div>
}))

describe('WorkflowBuilder', () => {
  const mockSave = vi.fn()
  const mockRun = vi.fn()
  const mockUpdateTemplate = vi.fn()
  const mockAddStep = vi.fn().mockReturnValue('s2')

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.mocked(useWorkflow).mockReturnValue({
      template: {
        id: 't1',
        name: 'My Workflow',
        steps: [{ id: 's1', type: 'shell', name: 'Step 1' }]
      },
      templates: [],
      executions: [],
      saveTemplate: mockSave,
      runWorkflow: mockRun,
      updateTemplate: mockUpdateTemplate,
      addStep: mockAddStep,
      removeStep: vi.fn(),
      updateStep: vi.fn()
    } as unknown as ReturnType<typeof useWorkflow>)
  })

  it('renders steps from template', () => {
    render(<WorkflowBuilder templateId="t1" projectId="proj-1" />)
    expect(screen.getByTestId('mock-step-list')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-name-input')).toHaveValue('My Workflow')
  })

  it('Add Step button calls addStep', () => {
    render(<WorkflowBuilder projectId="proj-1" />)
    fireEvent.click(screen.getByTestId('add-step'))
    expect(mockAddStep).toHaveBeenCalled()
  })

  it('updating name field updates local template state', () => {
    render(<WorkflowBuilder projectId="proj-1" />)
    fireEvent.change(screen.getByTestId('workflow-name-input'), { target: { value: 'New Name' } })
    expect(mockUpdateTemplate).toHaveBeenCalledWith({ name: 'New Name' })
  })

  it('Save button calls saveTemplate', async () => {
    render(<WorkflowBuilder projectId="proj-1" />)
    fireEvent.click(screen.getByTestId('save-workflow-btn'))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled()
    })
  })

  it('Run button calls runWorkflow with the projectId prop', () => {
    render(<WorkflowBuilder projectId="proj-1" />)
    fireEvent.click(screen.getByTestId('run-workflow-btn'))
    expect(mockRun).toHaveBeenCalledWith('proj-1')
  })

  it('Show DAG toggle shows/hides the DAGPreview panel', async () => {
    render(<WorkflowBuilder projectId="proj-1" />)

    // Initially hidden
    expect(screen.queryByTestId('mock-dag-preview')).not.toBeInTheDocument()

    // Show DAG
    fireEvent.click(screen.getByTestId('toggle-dag-preview'))
    await waitFor(() => {
      expect(screen.getByTestId('mock-dag-preview')).toBeInTheDocument()
    })

    // Hide DAG
    fireEvent.click(screen.getByTestId('toggle-dag-preview'))
    await waitFor(() => {
      expect(screen.queryByTestId('mock-dag-preview')).not.toBeInTheDocument()
    })
  })
})
