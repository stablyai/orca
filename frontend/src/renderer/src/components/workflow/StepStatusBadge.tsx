import type { StepStatus, WorkflowExecutionStatus } from '@shared/workflow-types'
import { CheckCircle2, Loader2, Clock, XCircle, SkipForward, Ban, Pause } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ReactNode } from 'react'

// Accepts both StepStatus (a single step) and WorkflowExecutionStatus (a whole
// execution) — ExecutionMonitor.tsx renders this badge for both. The two enums
// overlap on 4 values but diverge on the 5th ('skipped' vs 'cancelled'), so the
// map below is keyed on their union rather than either type alone (CR-PW-004;
// was `STEP_STATUS[status]` throwing on 'cancelled' via an `as any` cast).
type BadgeStatus = StepStatus | WorkflowExecutionStatus

const STEP_STATUS: Record<BadgeStatus, { icon: ReactNode; className: string; label: string }> = {
  pending: { icon: <Clock size={14} />, className: 'text-gray-400', label: 'Pending' },
  running: {
    icon: <Loader2 size={14} className="animate-spin" />,
    className: 'text-blue-500',
    label: 'Running'
  },
  // FE-TASK-003: WorkflowExecutionStatus now includes 'paused' — BadgeStatus's Record is
  // exhaustive, so this badge (rendered for execution.status too) needed an entry or it
  // throws on any paused execution.
  paused: { icon: <Pause size={14} />, className: 'text-amber-500', label: 'Paused' },
  completed: { icon: <CheckCircle2 size={14} />, className: 'text-green-500', label: 'Completed' },
  failed: { icon: <XCircle size={14} />, className: 'text-red-500', label: 'Failed' },
  skipped: { icon: <SkipForward size={14} />, className: 'text-gray-400', label: 'Skipped' },
  cancelled: { icon: <Ban size={14} />, className: 'text-gray-500', label: 'Cancelled' }
}

export function StepStatusBadge({ status }: { status: BadgeStatus }) {
  const { icon, className, label } = STEP_STATUS[status]
  return (
    <span className={cn('flex items-center gap-1 text-xs font-medium', className)}>
      {icon} {label}
    </span>
  )
}
