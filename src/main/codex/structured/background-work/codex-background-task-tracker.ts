import type { StructuredAgentSessionEndedEvent } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionChildWorkProducer } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-subagent-rows'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session/agent-session-background-task-wire'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import {
  observeCodexExecutionFrame,
  readCodexBackgroundTaskFrame,
  type CodexBackgroundTaskEvent
} from './codex-background-task-frames'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import {
  CodexBackgroundCommandTracker,
  type CodexBackgroundCommandChange
} from './codex-background-command-tracker'
import { CodexChildWorkEvidence } from './codex-child-work-evidence'
import type { CodexAbandonedCommand } from '../prompts/codex-prompt-registry'
import type { CodexStructuredSessionAdapterDeps } from '../session-lifecycle/codex-structured-session-state'
import { boundSubagentLabel } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'
import { codexChildCommandDescription } from '../../../../shared/codex-child-command-description'

export type CodexChildWorkSink = {
  deliver: (evidence: AgentChildWorkEvidence[]) => void
  now: () => number
}

export function codexChildWorkSink(
  sessionId: string,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'onChildWorkEvidence' | 'now'>,
  producer?: StructuredAgentSessionChildWorkProducer
): CodexChildWorkSink {
  return {
    deliver: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence, producer),
    now: () => deps.now?.() ?? Date.now()
  }
}

/** No answer leaves support unknown and permits a later retry. */
export type CodexTerminalStopSupport = 'supported' | 'unsupported' | 'unknown'

/** Projects the same child execution facts the durable roster consumes. */
export class CodexBackgroundTaskTracker {
  private publishedFingerprint = '[]'
  private publishedState: AgentSessionBackgroundTaskState | null = null
  private readonly projectedTasks = new Map<string, AgentSessionBackgroundTask>()
  private readonly commands: CodexBackgroundCommandTracker
  private readonly childWork: CodexChildWorkEvidence
  private terminalStops: CodexTerminalStopSupport | 'probing' = 'unknown'

  constructor(
    private readonly primaryThreadId: string,
    private readonly executions = new CodexSubagentExecutions(),
    private readonly childWorkSink?: CodexChildWorkSink
  ) {
    this.commands = new CodexBackgroundCommandTracker(primaryThreadId)
    this.childWork = new CodexChildWorkEvidence(
      primaryThreadId,
      executions,
      (threadId) => this.commands.threadCommands(threadId),
      () => this.stopsTerminals
    )
  }

  get stopsTerminals(): boolean {
    return this.terminalStops === 'supported'
  }

  /** Starts one probe once a command has a process ID; unknown results permit retry. */
  beginTerminalStopProbe(): boolean {
    if (this.terminalStops !== 'unknown' || !this.commands.holdsProcess) {
      return false
    }
    this.terminalStops = 'probing'
    return true
  }

  /** Restates stoppable commands on success; callers must then publish child work. */
  settleTerminalStopProbe(support: CodexTerminalStopSupport): void {
    if (this.terminalStops !== 'probing') {
      return
    }
    this.terminalStops = support
    if (support === 'supported') {
      this.childWork.restateCommands(this.commands.liveCommands())
    }
  }

  backgroundProcesses(taskIds: readonly string[]): { threadId: string; processId: string }[] {
    return this.stopsTerminals ? this.commands.backgroundProcesses(taskIds) : []
  }

  /** Includes descendants' active turns and supported terminals; task IDs here are thread IDs. */
  subagentStopTargets(taskIds: readonly string[]): {
    turns: { threadId: string; turnId: string }[]
    terminals: { threadId: string; processId: string }[]
  } {
    const named = new Set(
      taskIds.filter((id) => {
        const child = this.executions.find(id)
        return child?.registered && child.execution?.state === 'working'
      })
    )
    const lineage = named.size
      ? this.executions.lineage(
          named,
          this.commands.liveCommands().map((command) => command.threadId)
        )
      : []
    const threads = [...new Set(lineage.map((child) => child.agentThreadId))]
    return {
      turns: threads.flatMap((threadId) => {
        const execution = this.executions.find(threadId)?.execution
        return execution?.state === 'working' ? [{ threadId, turnId: execution.turnId }] : []
      }),
      terminals: this.stopsTerminals
        ? threads.flatMap((threadId) =>
            this.commands
              .threadCommands(threadId)
              .flatMap((command) =>
                command.type === 'started' && command.processId !== undefined
                  ? [{ threadId, processId: command.processId }]
                  : []
              )
          )
        : []
    }
  }

  runsSubagentTurn(threadId: string, turnId: string): boolean {
    const execution = this.executions.find(threadId)?.execution
    return execution?.state === 'working' && execution.turnId === turnId
  }

  get state(): AgentSessionBackgroundTaskState | null {
    // Journal admission precedes observe; readers must not see its pending facts.
    return this.publishedState
  }

  /** `unapproved`: commands whose approval the journal dropped with this frame's turn ending. */
  observe(
    event: CodexBackgroundTaskEvent,
    unapproved: readonly CodexAbandonedCommand[] = []
  ): boolean {
    const itemEvent = event.method === 'item/started' || event.method === 'item/completed'
    const command = itemEvent ? this.commands.observe(event) : null
    const frame = readCodexBackgroundTaskFrame(event, this.primaryThreadId)
    const commands = [
      ...unapproved.flatMap((abandoned) => this.commands.endUnapproved(abandoned) ?? []),
      ...(frame?.kind === 'turn' && frame.state !== 'working'
        ? this.commands.endTurn(frame.threadId, frame.turnId)
        : []),
      ...(event.method === 'thread/closed'
        ? this.commands.endThread(event.threadId)
        : command
          ? [command]
          : [])
    ]
    observeCodexExecutionFrame(this.executions, frame, this.primaryThreadId)
    this.childWork.observe(event, frame, commands)
    // The journal may have dirtied this shared registry before admitting the frame.
    return this.updateProjection(this.executions.takeChangedThreads(), commands)
      ? this.refresh()
      : false
  }

  clear(processExit?: StructuredAgentSessionEndedEvent['processExit']): boolean {
    this.childWork.clear(this.commands.clear(), processExit)
    this.executions.clear()
    this.projectedTasks.clear()
    return this.refresh()
  }

  drainChildWorkEvidence(observedAt: number): AgentChildWorkEvidence[] {
    return this.childWork.drain(observedAt)
  }

  /** Publish after the journal frame and parent row, so child records cannot arrive ahead of either. */
  publishChildWork(): void {
    // Drained even with no sink, so undelivered evidence never accumulates.
    const evidence = this.drainChildWorkEvidence(this.childWorkSink?.now() ?? Date.now())
    if (evidence.length > 0) {
      this.childWorkSink?.deliver(evidence)
    }
  }

  private tasks(): AgentSessionBackgroundTask[] {
    const children = this.executions.workingChildren()
    const agents: AgentSessionBackgroundTask[] = children.map((child) => ({
      id: `codex-agent:${child.agentThreadId}`,
      kind: 'agent',
      ...(child.label ? { description: boundSubagentLabel(child.label) } : {})
    }))
    return [
      ...agents,
      ...this.commands.tasks(new Set(children.map((child) => child.agentThreadId)), (threadId) =>
        this.executions.label(threadId)
      )
    ]
  }

  private updateProjection(
    threads: readonly string[],
    commands: readonly CodexBackgroundCommandChange[]
  ): boolean {
    let changed = false
    for (const threadId of threads) {
      const child = this.executions.find(threadId)
      const task =
        child?.registered && child.execution?.state === 'working'
          ? {
              id: `codex-agent:${threadId}`,
              kind: 'agent' as const,
              ...(child.label ? { description: boundSubagentLabel(child.label) } : {})
            }
          : null
      changed = this.projectTask(`codex-agent:${threadId}`, task) || changed
      for (const command of this.commands.threadCommands(threadId)) {
        changed = this.projectCommand(command) || changed
      }
    }
    for (const command of commands) {
      changed = this.projectCommand(command) || changed
    }
    return changed
  }

  private projectCommand(command: CodexBackgroundCommandChange): boolean {
    if (command.type === 'ended') {
      return this.projectTask(command.taskId, null)
    }
    const child = this.executions.find(command.threadId)
    if (!command.backgrounded || (child?.registered && child.execution?.state === 'working')) {
      return this.projectTask(command.task.id, null)
    }
    const label =
      command.threadId === this.primaryThreadId ? null : this.executions.label(command.threadId)
    const task = label
      ? {
          ...command.task,
          description: codexChildCommandDescription(label, command.task.description)
        }
      : command.task
    return this.projectTask(task.id, task)
  }

  private projectTask(id: string, task: AgentSessionBackgroundTask | null): boolean {
    if (task === null) {
      return this.projectedTasks.delete(id)
    }
    const previous = this.projectedTasks.get(id)
    if (previous?.kind === task.kind && previous.description === task.description) {
      return false
    }
    this.projectedTasks.set(id, task)
    return true
  }

  private refresh(): boolean {
    const tasks = this.tasks()
    const fingerprint = JSON.stringify(tasks)
    if (fingerprint === this.publishedFingerprint) {
      return false
    }
    this.publishedFingerprint = fingerprint
    this.publishedState = tasks.length
      ? { state: 'monitoring', tasks, supportsStopAll: false }
      : null
    return true
  }
}
