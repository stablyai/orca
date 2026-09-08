import { useState } from 'react'
import { useWorkspace } from '../../context/WorkspaceContext'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Loader2 } from 'lucide-react'
import { Tracers } from '../../../../shared/trace/tracers'
import type { OrcaTask } from '../../../../shared/task-types'

export function TaskPromptEditor({ task }: { task: OrcaTask }) {
  const [prompt, setPrompt] = useState(task.promptTemplate ?? '')
  const [isRunning, setIsRunning] = useState(false)
  const { project, currentWorktree } = useWorkspace()

  const runWithAgent = async () => {
    setIsRunning(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const span = Tracers.uiTaskGraphExecuteFlow.start({
      taskId: task.id,
      entryPoint: 'prompt-editor',
      promptLength: prompt.length
    })
    try {
      // BACKLOG-016: task.execute now accepts `prompt` — an empty value
      // (user never edited the textarea) falls back to the executor's own
      // default (SimpleExecutor.buildExecutePrompt, built from the task's
      // title), same behavior as before this field existed.
      await callRuntimeRpc(target, 'task.execute', {
        taskId: task.id,
        projectId: project!.id,
        worktreePath: currentWorktree!.path,
        prompt,
        traceId: span.id
      })
      span.ok({ taskId: task.id })
    } catch (err) {
      span.fail(err, { taskId: task.id })
      throw err
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="task-prompt-editor space-y-3 mt-3" data-testid="task-prompt-editor">
      <textarea
        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe what the agent should do for this task..."
        rows={4}
      />
      <Button
        onClick={runWithAgent}
        disabled={isRunning || !prompt.trim()}
        data-testid="run-agent-btn"
      >
        {isRunning ? (
          <>
            <Loader2 size={12} className="animate-spin mr-1" />
            Running...
          </>
        ) : (
          '▶ Run with Agent'
        )}
      </Button>
    </div>
  )
}
