import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, Loader2, MessageSquare } from 'lucide-react'
import type {
  ClickUpComment,
  ClickUpList,
  ClickUpTask,
  ClickUpTaskUpdate
} from '../../../shared/clickup-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  clickUpAddTaskComment,
  clickUpListLists,
  clickUpTaskComments,
  clickUpUpdateTask
} from '@/runtime/runtime-clickup-client'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { getIntlLocale, translate } from '@/i18n/i18n'

function dateInputValue(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? ''
}

export function ClickUpTaskDetailSheet({
  task,
  sourceContext,
  onClose,
  onStartWorkspace,
  onTaskChanged
}: {
  task: ClickUpTask | null
  sourceContext: TaskSourceContext | null
  onClose: () => void
  onStartWorkspace: (task: ClickUpTask) => void
  onTaskChanged: (task: ClickUpTask) => void
}): React.JSX.Element {
  const refreshTask = useAppStore((state) => state.fetchClickUpTask)
  const patchTask = useAppStore((state) => state.patchClickUpTask)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('none')
  const [dueDate, setDueDate] = useState('')
  const [lists, setLists] = useState<ClickUpList[]>([])
  const [comments, setComments] = useState<ClickUpComment[]>([])
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taskRef = useRef(task)
  taskRef.current = task
  const draftRef = useRef({ name, description, status, priority, dueDate })
  draftRef.current = { name, description, status, priority, dueDate }
  const commentTaskIdRef = useRef<string | null>(null)
  // Why: each comment submission owns the pending state; a task switch or a
  // newer submission bumps this, so a late result can't touch the current one.
  const commentSubmissionRef = useRef(0)

  useEffect(() => {
    if (!task) {
      return
    }
    // Why: only a different task drops the comment draft; a same-task refresh
    // (for example after a save) must keep what the user is typing.
    if (commentTaskIdRef.current !== task.id) {
      commentTaskIdRef.current = task.id
      commentSubmissionRef.current += 1
      setComment('')
      setCommenting(false)
    }
    setName(task.name)
    setDescription(task.description ?? '')
    setStatus(task.status.name)
    setPriority(task.priority ? String(task.priority.id) : 'none')
    setDueDate(dateInputValue(task.dueDate))
    setError(null)
    let cancelled = false
    void Promise.all([
      // Why the listId: the sheet only needs this task's List statuses; walking
      // the whole hierarchy costs a request per Space.
      clickUpListLists(sourceContext, task.workspaceId, task.list.id),
      clickUpTaskComments(sourceContext, task.id, task.workspaceId)
    ])
      .then(([nextLists, nextComments]) => {
        if (!cancelled && taskRef.current?.id === task.id) {
          setLists(nextLists)
          setComments(nextComments)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load task details.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceContext, task])

  const taskList = useMemo(
    () => lists.find((list) => list.id === task?.list.id),
    [lists, task?.list.id]
  )

  const handleSave = async (): Promise<void> => {
    if (!task || !name.trim() || saving) {
      return
    }
    const update: ClickUpTaskUpdate = {
      ...(name.trim() !== task.name ? { name: name.trim() } : {}),
      ...(description !== (task.description ?? '') ? { description } : {}),
      ...(status !== task.status.name ? { status } : {}),
      ...(priority !== (task.priority ? String(task.priority.id) : 'none')
        ? { priority: priority === 'none' ? null : Number(priority) }
        : {}),
      ...(dueDate !== dateInputValue(task.dueDate) ? { dueDate: dueDate || null } : {})
    }
    if (Object.keys(update).length === 0) {
      return
    }
    const savedTaskId = task.id
    const savedDraft = {
      name: name.trim(),
      description,
      status,
      priority,
      dueDate
    }
    setSaving(true)
    setError(null)
    const result = await clickUpUpdateTask(sourceContext, task.id, update, task.workspaceId).catch(
      (cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : 'Task update failed.'
      })
    )
    if (!result.ok) {
      setSaving(false)
      setError(result.error)
      return
    }
    patchTask(
      task.id,
      {
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.status !== undefined ? { status: { ...task.status, name: update.status } } : {}),
        ...(update.dueDate !== undefined ? { dueDate: update.dueDate } : {})
      },
      sourceContext
    )
    const refreshed = await refreshTask(task.id, task.workspaceId, {
      force: true,
      sourceContext
    }).catch(() => null)
    setSaving(false)
    if (refreshed) {
      patchTask(savedTaskId, refreshed, sourceContext)
      const stillOnTask = taskRef.current?.id === savedTaskId
      const currentDraft = draftRef.current
      const draftUnchanged =
        currentDraft.name.trim() === savedDraft.name &&
        currentDraft.description === savedDraft.description &&
        currentDraft.status === savedDraft.status &&
        currentDraft.priority === savedDraft.priority &&
        currentDraft.dueDate === savedDraft.dueDate
      if (stillOnTask && draftUnchanged) {
        onTaskChanged(refreshed)
      }
    }
  }

  const handleComment = async (): Promise<void> => {
    if (!task || !comment.trim() || commenting) {
      return
    }
    setCommenting(true)
    setError(null)
    const submission = ++commentSubmissionRef.current
    const isCurrent = (): boolean => commentSubmissionRef.current === submission
    const taskId = task.id
    const result = await clickUpAddTaskComment(
      sourceContext,
      taskId,
      comment.trim(),
      task.workspaceId
    ).catch((cause: unknown) => ({
      ok: false as const,
      error: cause instanceof Error ? cause.message : 'Comment failed.'
    }))
    if (!isCurrent()) {
      return
    }
    if (!result.ok) {
      setCommenting(false)
      setError(result.error)
      return
    }
    try {
      const nextComments = await clickUpTaskComments(sourceContext, taskId, task.workspaceId)
      if (isCurrent()) {
        setComments(nextComments)
        setComment('')
      }
    } catch (cause: unknown) {
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : 'Failed to reload comments.')
      }
    } finally {
      if (isCurrent()) {
        setCommenting(false)
      }
    }
  }

  return (
    <Sheet open={Boolean(task)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="min-w-[min(92vw,560px)]">
        {task ? (
          <>
            <div className="border-b border-border pr-12">
              <SheetHeader>
                <SheetTitle>{task.customId ?? task.id}</SheetTitle>
                <SheetDescription>
                  {[task.workspaceName, task.space?.name, task.folder?.name, task.list.name]
                    .filter(Boolean)
                    .join(' / ')}
                </SheetDescription>
              </SheetHeader>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 scrollbar-sleek">
              <div className="space-y-2">
                <Label htmlFor="clickup-detail-name">
                  {translate('auto.components.clickup.detail.name', 'Name')}
                </Label>
                <Input
                  id="clickup-detail-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="clickup-detail-description">
                  {translate('auto.components.clickup.detail.description', 'Description')}
                </Label>
                <Textarea
                  id="clickup-detail-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={8}
                  className="resize-y"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>{translate('auto.components.clickup.detail.status', 'Status')}</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(taskList?.statuses ?? [task.status]).map((option) => (
                        <SelectItem key={option.name} value={option.name}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{translate('auto.components.clickup.detail.priority', 'Priority')}</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        {translate('auto.components.clickup.detail.priorityNone', 'None')}
                      </SelectItem>
                      <SelectItem value="1">
                        {translate('auto.components.clickup.detail.priorityUrgent', 'Urgent')}
                      </SelectItem>
                      <SelectItem value="2">
                        {translate('auto.components.clickup.detail.priorityHigh', 'High')}
                      </SelectItem>
                      <SelectItem value="3">
                        {translate('auto.components.clickup.detail.priorityNormal', 'Normal')}
                      </SelectItem>
                      <SelectItem value="4">
                        {translate('auto.components.clickup.detail.priorityLow', 'Low')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="clickup-detail-due-date">
                    {translate('auto.components.clickup.detail.dueDate', 'Due date')}
                  </Label>
                  <Input
                    id="clickup-detail-due-date"
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </div>
              </div>
              <section className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <MessageSquare className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold text-foreground">
                    {translate('auto.components.clickup.detail.comments', 'Comments')}
                  </h3>
                </div>
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={3}
                  className="resize-y"
                  placeholder={translate(
                    'auto.components.clickup.detail.commentPlaceholder',
                    'Add a comment…'
                  )}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!comment.trim() || commenting}
                  onClick={() => void handleComment()}
                >
                  {commenting ? <Loader2 className="animate-spin" /> : null}
                  {translate('auto.components.clickup.detail.addComment', 'Add comment')}
                </Button>
                <div className="space-y-3">
                  {comments.map((item) => (
                    <div key={item.id} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {item.user?.username ??
                            translate(
                              'auto.components.ClickUpTaskDetailSheet.unknownCommentAuthor',
                              'ClickUp user'
                            )}
                        </span>
                        <span>{new Date(item.createdAt).toLocaleString(getIntlLocale())}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                        {item.body}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <div className="flex flex-row items-center justify-between gap-2 border-t border-border p-4">
              <Button variant="outline" onClick={() => void window.api.shell.openUrl(task.url)}>
                <ExternalLink />
                {translate('auto.components.clickup.detail.open', 'Open in ClickUp')}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onStartWorkspace(task)}>
                  <ArrowRight />
                  {translate('auto.components.clickup.detail.startWorkspace', 'Start workspace')}
                </Button>
                <Button onClick={() => void handleSave()} disabled={!name.trim() || saving}>
                  {saving ? <Loader2 className="animate-spin" /> : null}
                  {translate('auto.components.clickup.detail.save', 'Save')}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
