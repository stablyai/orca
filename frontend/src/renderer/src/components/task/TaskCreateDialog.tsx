import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { toast } from 'sonner'

export function TaskCreateDialog({
  projectId,
  onCreated,
  onCancel
}: {
  projectId: string
  onCreated: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const create = async () => {
    if (!title.trim()) {
      return
    }
    setIsCreating(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      // The backend today only decodes {title, parentId} (channels.go's createArgs) —
      // projectId sent here is silently dropped until that struct gains a ProjectID
      // field. Still sending it now avoids a second call-site change later.
      await callRuntimeRpc(target, 'task.create', { title: title.trim(), projectId })
      toast.success(`Task "${title.trim()}" created`)
      onCreated()
    } catch (err) {
      toast.error(`Failed to create task: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div
      className="task-create-dialog border rounded p-3 bg-background shadow-sm"
      data-testid="task-create-dialog"
    >
      <Input
        autoFocus
        placeholder="Task title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        data-testid="task-create-title-input"
        className="mb-2"
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="task-create-cancel">
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!title.trim() || isCreating}
          onClick={create}
          data-testid="task-create-submit"
        >
          {isCreating ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
