// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskGraph } from '../TaskGraph'
import { useTasks } from '../../../hooks/useTasks'

vi.mock('../../../hooks/useTasks', () => ({
  useTasks: vi.fn()
}))

vi.mock('../TaskTreeView', () => ({
  TaskTreeView: () => <div data-testid="mock-tree-view" />
}))
vi.mock('../TaskDAGView', () => ({
  default: () => <div data-testid="mock-dag-view" />
}))
vi.mock('../TaskBoardView', () => ({
  TaskBoardView: () => <div data-testid="mock-board-view" />
}))
vi.mock('../TaskCreateDialog', () => ({
  TaskCreateDialog: ({ onCreated }: { onCreated: () => void }) => (
    <div data-testid="mock-task-create-dialog">
      <button data-testid="mock-created" onClick={onCreated}>
        created
      </button>
    </div>
  )
}))

const mockUseTasks = vi.mocked(useTasks)

describe('TaskGraph', () => {
  const refetch = vi.fn()

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockUseTasks.mockReturnValue({
      filteredTasks: [],
      expandedNodes: new Set(),
      toggleExpanded: vi.fn(),
      setActiveTask: vi.fn(),
      filterStatus: 'all',
      setFilterStatus: vi.fn(),
      searchQuery: '',
      setSearchQuery: vi.fn(),
      isLoading: false,
      refetch,
      dagView: null
    })
  })

  it('clicking "+ New Task" shows TaskCreateDialog', () => {
    render(<TaskGraph projectId="p1" />)
    expect(screen.queryByTestId('mock-task-create-dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('new-task-btn'))
    expect(screen.getByTestId('mock-task-create-dialog')).toBeInTheDocument()
  })

  it('TaskCreateDialog onCreated calls refetch() and closes the dialog', () => {
    render(<TaskGraph projectId="p1" />)
    fireEvent.click(screen.getByTestId('new-task-btn'))
    fireEvent.click(screen.getByTestId('mock-created'))
    expect(refetch).toHaveBeenCalled()
    expect(screen.queryByTestId('mock-task-create-dialog')).not.toBeInTheDocument()
  })

  it('clicking "Board" switches viewMode, renders TaskBoardView instead of Tree/DAG', async () => {
    render(<TaskGraph projectId="p1" />)
    expect(screen.getByTestId('mock-tree-view')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('view-board'))
    await waitFor(() => {
      expect(screen.getByTestId('mock-board-view')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('mock-tree-view')).not.toBeInTheDocument()
  })
})
