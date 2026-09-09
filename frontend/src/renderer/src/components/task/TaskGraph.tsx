import { lazy, Suspense, useState } from 'react'
import { useTasks } from '../../hooks/useTasks'
import { TaskTreeView } from './TaskTreeView'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { TaskCreateDialog } from './TaskCreateDialog'

const TaskDAGView = lazy(() => import('./TaskDAGView'))
const TaskBoardView = lazy(() =>
  import('./TaskBoardView').then((m) => ({ default: m.TaskBoardView }))
)

export function TaskGraph({ projectId }: { projectId: string }) {
  const {
    filteredTasks,
    expandedNodes,
    toggleExpanded,
    setActiveTask,
    filterStatus,
    setFilterStatus,
    searchQuery,
    setSearchQuery,
    refetch
  } = useTasks(projectId)
  const [viewMode, setViewMode] = useState<'tree' | 'dag' | 'board'>('tree')
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  return (
    <div className="task-graph flex flex-col h-full" data-testid="task-graph">
      <div className="flex items-center gap-2 p-2 border-b">
        <Button size="sm" onClick={() => setShowCreateDialog(true)} data-testid="new-task-btn">
          + New Task
        </Button>
        <Input
          placeholder="Search tasks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 h-7 text-sm"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="text-sm border rounded px-2 py-1"
        >
          <option value="all">All Status</option>
          <option value="todo">Todo</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
        </select>
        <div className="flex border rounded overflow-hidden">
          <button
            onClick={() => setViewMode('tree')}
            className={`px-2 py-1 text-xs ${viewMode === 'tree' ? 'bg-primary text-primary-foreground' : ''}`}
            data-testid="view-tree"
          >
            Tree
          </button>
          <button
            onClick={() => setViewMode('dag')}
            className={`px-2 py-1 text-xs ${viewMode === 'dag' ? 'bg-primary text-primary-foreground' : ''}`}
            data-testid="view-dag"
          >
            DAG
          </button>
          <button
            onClick={() => setViewMode('board')}
            className={`px-2 py-1 text-xs ${viewMode === 'board' ? 'bg-primary text-primary-foreground' : ''}`}
            data-testid="view-board"
          >
            Board
          </button>
        </div>
      </div>
      {showCreateDialog && (
        <TaskCreateDialog
          projectId={projectId}
          onCreated={() => {
            setShowCreateDialog(false)
            refetch()
          }}
          onCancel={() => setShowCreateDialog(false)}
        />
      )}
      <div className="flex-1 overflow-auto">
        {viewMode === 'board' ? (
          <Suspense fallback={<div className="p-4 text-sm">Loading Board...</div>}>
            <TaskBoardView tasks={filteredTasks} onSelect={setActiveTask} />
          </Suspense>
        ) : viewMode === 'tree' ? (
          <TaskTreeView
            tasks={filteredTasks}
            expandedNodes={expandedNodes}
            toggleExpanded={toggleExpanded}
            setActiveTask={setActiveTask}
          />
        ) : (
          <Suspense fallback={<div className="p-4 text-sm">Loading DAG...</div>}>
            <TaskDAGView tasks={filteredTasks} onSelect={setActiveTask} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
