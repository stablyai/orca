import { record, taskAliasId, taskId } from './claude-background-task-frames'
import type { ClaudeBackgroundTaskDescriptor } from './claude-background-task-identity'

export type ClaudeTaskInvocation = {
  toolUseId?: string
  parentTaskId?: string
  /** Only current provider evidence may correct durable producer attribution. */
  reportedParentTaskId?: string
  excluded: boolean
  monitor: boolean
  ended?: { status: string; toolUseId?: string }
  /** Only accepted current evidence proves an alias is historical after replacement. */
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
      const start = message.subtype === 'task_started'
      const selection = this.select(id, run, start)
      const { invocation, acceptsStart } = selection
      if ((!start && !roster) || acceptsStart) {
        invocation.observed ||= selection.current
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
        invocation.ended = { status: String(frame.status), toolUseId: invocation.toolUseId }
      }
      if (invocation.toolUseId) {
        this.tasks.get(id)!.aliases.set(invocation.toolUseId, invocation)
      }
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

  excludeMonitor(id: string, run?: string): void {
    this.select(id, taskAliasId(run), true).invocation.monitor = true
  }

  settle(id: string, status: unknown, run?: string): void {
    const invocation = this.get(id, run)
    if (invocation) {
      invocation.ended = { status: String(status), toolUseId: invocation.toolUseId }
    }
  }

  settleFrame(id: string, message: Record<string, unknown>): void {
    this.settle(
      id,
      record(message.patch)?.status ?? message.status,
      taskAliasId(message.tool_use_id) ?? taskAliasId(record(message.patch)?.tool_use_id)
    )
  }

  clear(): void {
    this.tasks.clear()
  }

  private select(id: string, run: string | undefined, start: boolean): Selection {
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
    let invocation = task.current
    if (run !== undefined && invocation.toolUseId !== undefined && invocation.toolUseId !== run) {
      const saved = this.saved?.background(id, run)
      invocation = task.aliases.get(run) ?? this.recover(id, run)
      // A known historical alias cannot replace the current invocation; a pending tool result can.
      if (
        start &&
        !invocation.observed &&
        saved?.toolUseId !== run &&
        (task.current.ended !== undefined || !task.current.observed)
      ) {
        task.current = invocation
      }
      task.aliases.set(run, invocation)
    }
    const current = task.current === invocation
    return {
      invocation,
      current,
      acceptsStart:
        current &&
        (invocation.ended === undefined ||
          (start &&
            (invocation.ended.status === 'completed' || invocation.ended.toolUseId === undefined)))
    }
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
