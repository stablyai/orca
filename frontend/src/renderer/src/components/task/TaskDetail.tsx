import { useState, useEffect } from 'react'
import { useAppStore } from '../../store'
import { useTask } from '../../hooks/useTask'
import { useAuthUser } from '../../hooks/useAuthSession'
import { useTaskActivity } from '../../hooks/useTaskActivity'
import { useWorkspace } from '../../context/WorkspaceContext'
import { Input } from '../ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { TaskAIDecompose } from './TaskAIDecompose'
import { TaskPromptEditor } from './TaskPromptEditor'
import { TaskGrantModal } from './TaskGrantModal'
import { TaskStatusBadge } from './TaskStatusBadge'
import { Button } from '../ui/button'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toast } from 'sonner'
import { Tracers } from '../../../../shared/trace/tracers'
import type {
  OrcaTask,
  TaskEdgeType,
  TaskStatus,
  TaskPriority
} from '../../../../shared/task-types'

// Right-panel detail view for active task
// Fields: title (editable), description (textarea), type, status, priority, assignee, progress
// Tabs: Details | Subtasks | AI Agent

const TASK_STATUSES: OrcaTask['status'][] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled'
]

export function TaskDetail() {
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const { task, updateTask } = useTask(activeTaskId!)
  const { project, currentWorktree } = useWorkspace()
  const currentUser = useAuthUser()
  const [localTitle, setLocalTitle] = useState(task?.title ?? '')
  const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'ai' | 'access'>('details')
  // Defaults to true so the Run button isn't hidden while resolvePermission is in flight.
  const [canManage, setCanManage] = useState(true)

  const [deps, setDeps] = useState<{ blockedBy: OrcaTask[]; blocks: OrcaTask[] }>({
    blockedBy: [],
    blocks: []
  })

  useEffect(() => {
    if (!task?.id) {
      return
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc(target, 'task.getDependencies', { taskId: task.id })
      .then((d) => {
        // task.getDependencies returns this task's own outgoing edges as a flat
        // { task, edgeType }[] — split by edgeType into the blockedBy/blocks split the UI wants.
        const edges = d as { task: OrcaTask; edgeType: TaskEdgeType }[]
        setDeps({
          blockedBy: edges.filter((e) => e.edgeType === 'depends_on').map((e) => e.task),
          blocks: edges.filter((e) => e.edgeType === 'blocks').map((e) => e.task)
        })
      })
      .catch(() => {})
  }, [task?.id])

  useEffect(() => {
    if (!task?.id || !currentUser?.id) {
      return
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // task.resolvePermission returns { effectiveLevel } (already lowercased, GRANT_LEVEL_
    // prefix stripped) — channels_automation_task.go:465-479. "owner"/"admin" gate Run here.
    callRuntimeRpc<{ effectiveLevel: string }>(target, 'task.resolvePermission', {
      taskId: task.id,
      userId: currentUser.id
    })
      .then((r) => setCanManage(r.effectiveLevel === 'owner' || r.effectiveLevel === 'admin'))
      .catch(() => setCanManage(false))
  }, [task?.id, currentUser?.id])

  // Polling fallback (no push channel yet — see useTaskActivity's own doc comment) so a
  // status change from a running agent shows up here without the user needing to F5.
  const { task: polledTask } = useTaskActivity(task?.id)

  if (!task) {
    return <div className="p-4 text-sm text-muted-foreground">Select a task</div>
  }

  const handleRunAgent = async () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // field `entryPoint: 'task-detail'` phân biệt với TaskPromptEditor (TASK-FE-018.3) —
    // 2 nút UI khác nhau cùng dẫn vào 1 tracer chung (BL-TG-04).
    const span = Tracers.uiTaskGraphExecuteFlow.start({
      taskId: task.id,
      entryPoint: 'task-detail'
    })
    try {
      await callRuntimeRpc(target, 'task.execute', {
        taskId: task.id,
        projectId: project!.id,
        worktreePath: currentWorktree!.path,
        traceId: span.id
      })
      span.ok({ taskId: task.id })
      toast.success(`Agent started for: ${task.title}`)
      // Optionally emit workspace event:
      // emit('agent.started', { taskId: task.id })
    } catch (err) {
      span.fail(err, { taskId: task.id })
      toast.error(`Failed to start agent: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="task-detail flex flex-col h-full p-4" data-testid="task-detail">
      {/* Title */}
      <Input
        value={localTitle}
        onChange={(e) => setLocalTitle(e.target.value)}
        onBlur={() => localTitle !== task.title && updateTask({ title: localTitle })}
        className="text-base font-semibold border-0 px-0 shadow-none"
        data-testid="task-title-input"
      />

      {/* Action Buttons */}
      <div className="flex gap-2 mt-2">
        {canManage && (
          <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
            ▶ Execute with Agent
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'details' | 'subtasks' | 'ai' | 'access')}
        className="mt-4"
      >
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="subtasks">Subtasks</TabsTrigger>
          <TabsTrigger value="ai">AI Agent</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          {/* Status, Priority, Type, Progress fields */}
          <div className="space-y-3 mt-3">
            <div className="flex items-center gap-2">
              <label className="text-sm w-24">Status</label>
              <Select
                value={task.status}
                onValueChange={(s) => updateTask({ status: s as TaskStatus })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <TaskStatusBadge status={polledTask?.status ?? task.status} />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm w-24">Priority</label>
              <Select
                value={task.priority}
                onValueChange={(p) => updateTask({ priority: p as TaskPriority })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['critical', 'high', 'medium', 'low'].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Dependencies */}
            <div className="pt-2 text-xs">
              <p className="font-semibold mb-1">Dependencies</p>
              {deps.blockedBy.length > 0 ? (
                <div className="text-muted-foreground flex gap-1">
                  <span>← Blocked by:</span>
                  <span>{deps.blockedBy.map((d) => d.title).join(', ')}</span>
                </div>
              ) : null}
              {deps.blocks.length > 0 ? (
                <div className="text-muted-foreground flex gap-1 mt-1">
                  <span>→ Blocks:</span>
                  <span>{deps.blocks.map((d) => d.title).join(', ')}</span>
                </div>
              ) : null}
              {deps.blockedBy.length === 0 && deps.blocks.length === 0 && (
                <div className="text-muted-foreground">No dependencies</div>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="subtasks">
          <TaskAIDecompose parentTask={task} />
        </TabsContent>
        <TabsContent value="ai">
          <TaskPromptEditor task={task} />
        </TabsContent>
        <TabsContent value="access">
          <TaskGrantModal taskId={task.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
