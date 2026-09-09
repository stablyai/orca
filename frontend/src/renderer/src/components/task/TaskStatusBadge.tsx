import type { TaskStatus, TaskPriority } from '../../../../shared/task-types'

// Colors kept in sync with TaskDAGView.tsx's STATUS_COLORS (review=purple, blocked=red) so
// the DAG and Board views agree on a color per status — see AGENTS.md's Design System.
const STATUS_CONFIG = {
  backlog: { label: 'Backlog', icon: '📋', className: 'text-slate-400' },
  todo: { label: 'Todo', icon: '⏳', className: 'text-gray-500' },
  in_progress: { label: 'In Progress', icon: '🔄', className: 'text-blue-600' },
  review: { label: 'Review', icon: '👀', className: 'text-purple-600' },
  done: { label: 'Done', icon: '✅', className: 'text-green-600' },
  blocked: { label: 'Blocked', icon: '🚫', className: 'text-red-600' },
  cancelled: { label: 'Cancelled', icon: '❌', className: 'text-gray-400' }
}

const PRIORITY_CONFIG = {
  critical: { label: 'Critical', className: 'text-red-600', dot: '🔴' },
  high: { label: 'High', className: 'text-orange-500', dot: '🟠' },
  medium: { label: 'Medium', className: 'text-yellow-600', dot: '🟡' },
  low: { label: 'Low', className: 'text-green-600', dot: '🟢' }
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.todo
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${config.className}`}
    >
      <span>{config.icon}</span>
      <span>{config.label}</span>
    </span>
  )
}

export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.low
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${config.className}`}
    >
      <span>{config.dot}</span>
      <span>{config.label}</span>
    </span>
  )
}
