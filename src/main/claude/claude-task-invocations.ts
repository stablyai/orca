import { record, taskAliasId, taskId } from './claude-background-task-frames'
import type { ClaudeBackgroundTaskDescriptor } from './claude-background-task-identity'

export type ClaudeTaskInvocation = {
  toolUseId?: string
  parentTaskId?: string
  /** Only current provider evidence may correct durable producer attribution. */
  reportedParentTaskId?: string
  excluded: boolean
  monitor: boolean
  ended?: string
  observed: boolean
}

type Selection = { invocation: ClaudeTaskInvocation; current: boolean; acceptsStart: boolean }
type Task = { current: ClaudeTaskInvocation; aliases: Map<string, ClaudeTaskInvocation> }

/** Acquisition-local provider facts; saved ownership never establishes a live task. */
export class ClaudeTaskInvocations {
  private readonly tasks = new Map<string, Task>()
  private readonly observations = new WeakMap<object, Map<string, Selection>>()

  constructor(
    private readonly saved?: {
      background: (id: string, run?: string) => ClaudeBackgroundTaskDescriptor | undefined
      parent: (id: string, run?: string) => string | undefined
    }
  ) {}

  observe(message: Record<string, unknown>): void {
    if (message.type !== 'system' || this.observations.has(message)) {
      return
    }
    const selections = new Map<string, Selection>()
    this.observations.set(message, selections)
    const roster = message.subtype === 'background_tasks_changed'
    const entries = roster && Array.isArray(message.tasks) ? message.tasks : [message]
    for (const entry of entries) {
      const frame = record(entry)
      const id = frame && taskId(frame)
      if (!frame || !id) {
        continue
      }
      const run = taskAliasId(frame.tool_use_id) ?? taskAliasId(record(frame.patch)?.tool_use_id)
      let task = this.tasks.get(id)
      if (!task) {
        const latest = this.saved?.background(id)
        const current = this.recover(id, latest ? undefined : run)
        task = { current, aliases: new Map() }
        if (current.toolUseId) {
          task.aliases.set(current.toolUseId, current)
        }
        this.tasks.set(id, task)
      }
      let invocation = task.aliases.get(run ?? '') ?? task.current
      const start = message.subtype === 'task_started'
      const distinct =
        run !== undefined && invocation.toolUseId !== undefined && invocation.toolUseId !== run
      if (distinct) {
        const descriptor = this.saved?.background(id, run)
        if (descriptor?.toolUseId === run) {
          invocation = this.recover(id, run)
        } else if (start && (invocation.ended !== undefined || !invocation.observed)) {
          invocation = this.recover(id, run)
          task.current = invocation
        } else {
          selections.set(id, { invocation, current: false, acceptsStart: false })
          continue
        }
      }
      const current = this.tasks.get(id)!.current === invocation
      const acceptsStart =
        current && (invocation.ended === undefined || (start && invocation.ended === 'completed'))
      if ((!start && !roster) || acceptsStart) {
        invocation.observed = true
        invocation.toolUseId ??= run
        invocation.reportedParentTaskId =
          taskAliasId(frame.parent_task_id) ?? invocation.reportedParentTaskId
        invocation.parentTaskId = invocation.reportedParentTaskId ?? invocation.parentTaskId
        invocation.excluded ||= frame.ambient === true || frame.skip_transcript === true
        if (start && acceptsStart) {
          invocation.ended = undefined
        }
      }
      if (message.subtype === 'task_notification') {
        invocation.ended = String(frame.status)
      }
      if (invocation.toolUseId) {
        this.tasks.get(id)!.aliases.set(invocation.toolUseId, invocation)
      }
      const selection = { invocation, current, acceptsStart }
      selections.set(id, selection)
      if (roster) {
        this.observations.set(frame, new Map([[id, selection]]))
      }
    }
  }

  selection(message: Record<string, unknown>, id: string): Selection | undefined {
    this.observe(message)
    return this.observations.get(message)?.get(id)
  }

  get(id: string, run?: string): ClaudeTaskInvocation | undefined {
    const task = this.tasks.get(id)
    return run === undefined
      ? task?.current
      : (task?.aliases.get(run) ??
          (task?.current.toolUseId === undefined ? task?.current : undefined))
  }

  parentOf = (id: string, run?: string): string | undefined => {
    const task = this.tasks.get(id)
    const invocation = run === undefined ? task?.current : task?.aliases.get(run)
    return invocation
      ? invocation.parentTaskId
      : (this.saved?.background(id, run)?.linkage.parentAgentId ?? this.saved?.parent(id, run))
  }

  excludeMonitor(id: string): void {
    const task = this.tasks.get(id)
    if (task) {
      task.current.monitor = true
    } else {
      this.tasks.set(id, { current: { ...this.recover(id), monitor: true }, aliases: new Map() })
    }
  }

  clear(): void {
    this.tasks.clear()
  }

  private recover(id: string, run?: string): ClaudeTaskInvocation {
    const descriptor = this.saved?.background(id, run)
    return {
      toolUseId: run ?? descriptor?.toolUseId,
      parentTaskId: descriptor?.linkage.parentAgentId ?? this.saved?.parent(id, run),
      observed: false,
      excluded: false,
      monitor: false
    }
  }
}
