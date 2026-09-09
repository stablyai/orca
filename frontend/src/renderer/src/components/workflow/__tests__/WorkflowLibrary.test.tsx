// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { WorkflowLibrary } from '../WorkflowLibrary'
import { useWorkflowLibrary } from '../../../hooks/useWorkflowLibrary'
import type { WorkflowDefinition } from '../../../../../shared/workflow-types'

vi.mock('../../../hooks/useWorkflowLibrary', () => ({
  useWorkflowLibrary: vi.fn()
}))

const mockUseWorkflowLibrary = vi.mocked(useWorkflowLibrary)

describe('WorkflowLibrary', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockUseWorkflowLibrary.mockReturnValue({
      templates: [],
      loading: false,
      loadError: false,
      reload: vi.fn()
    })
  })

  it('renders 3 tabs company/team/personal, defaults to company', () => {
    render(<WorkflowLibrary onUseTemplate={vi.fn()} />)
    expect(screen.getByText('Company Standards')).toBeInTheDocument()
    expect(screen.getByText('Team Templates')).toBeInTheDocument()
    expect(screen.getByText('My Workflows')).toBeInTheDocument()
    expect(mockUseWorkflowLibrary).toHaveBeenCalledWith('company', '')
  })

  it('empty templates → shows "No templates in this scope yet."', () => {
    render(<WorkflowLibrary onUseTemplate={vi.fn()} />)
    expect(screen.getByTestId('library-empty')).toHaveTextContent('No templates in this scope yet.')
  })

  it('click "Use" on a card → calls onUseTemplate(templateId)', () => {
    mockUseWorkflowLibrary.mockReturnValue({
      templates: [
        { id: 't1', name: 'Deploy', steps: [], scope: 'company' } as unknown as WorkflowDefinition
      ],
      loading: false,
      loadError: false,
      reload: vi.fn()
    })
    const onUseTemplate = vi.fn()
    render(<WorkflowLibrary onUseTemplate={onUseTemplate} />)
    fireEvent.click(screen.getByTestId('template-use'))
    expect(onUseTemplate).toHaveBeenCalledWith('t1')
  })

  it('typing into the search input → useWorkflowLibrary receives the new search value', async () => {
    render(<WorkflowLibrary onUseTemplate={vi.fn()} />)
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: 'deploy' } })
    await waitFor(() => {
      expect(mockUseWorkflowLibrary).toHaveBeenCalledWith('company', 'deploy')
    })
  })

  it('loading=true → shows loading state', () => {
    mockUseWorkflowLibrary.mockReturnValue({
      templates: [],
      loading: true,
      loadError: false,
      reload: vi.fn()
    })
    render(<WorkflowLibrary onUseTemplate={vi.fn()} />)
    expect(screen.getByTestId('library-loading')).toBeInTheDocument()
  })

  it('loadError=true → shows error state', () => {
    mockUseWorkflowLibrary.mockReturnValue({
      templates: [],
      loading: false,
      loadError: true,
      reload: vi.fn()
    })
    render(<WorkflowLibrary onUseTemplate={vi.fn()} />)
    expect(screen.getByTestId('library-error')).toBeInTheDocument()
  })
})
