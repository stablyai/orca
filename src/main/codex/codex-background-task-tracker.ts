import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import {
  readCodexBackgroundTaskFrame,
  type CodexBackgroundTaskEvent
} from './codex-background-task-frames'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { CodexBackgroundCommandTracker } from './codex-background-command-tracker'
import { boundSubagentField } from './codex-subagent-group-body'

/** Projects the same child execution facts the durable roster consumes. */
export class CodexBackgroundTaskTracker {
  private primaryTurnId: string | null = null
  private publishedFingerprint = '[]'
  private publishedState: AgentSessionBackgroundTaskState | null = null
  private readonly commands: CodexBackgroundCommandTracker

  constructor(
    private readonly primaryThreadId: string,
    private readonly executions = new CodexSubagentExecutions()
  ) {
    this.commands = new CodexBackgroundCommandTracker(primaryThreadId)
  }

  get state(): AgentSessionBackgroundTaskState | null {
    // Journal admission precedes observe; readers must not see its pending facts.
    return this.publishedState
  }

  canObserve(event: CodexBackgroundTaskEvent): boolean {
    return this.commands.canObserve(event)
  }

  observe(event: CodexBackgroundTaskEvent): boolean {
    const itemEvent = event.method === 'item/started' || event.method === 'item/completed'
    if (itemEvent) {
      this.commands.observe(event)
    }
    const frame = readCodexBackgroundTaskFrame(event, this.primaryThreadId)
    if (!frame) {
      return itemEvent ? this.refresh() : false
    }
    if (frame.kind === 'subagent') {
      this.executions.register(frame.agentThreadId, frame.label, frame.parentTurnId)
    } else if (frame.threadId === this.primaryThreadId) {
      if (frame.state === 'working') {
        this.primaryTurnId = frame.turnId
      } else if (frame.turnId === this.primaryTurnId) {
        this.primaryTurnId = null
      }
    } else {
      this.executions.observeTurn(frame.threadId, frame.turnId, frame.state)
    }
    return this.refresh()
  }

  clear(): boolean {
    this.executions.clear()
    this.commands.clear()
    this.primaryTurnId = null
    return this.refresh()
  }

  private tasks(): AgentSessionBackgroundTask[] {
    if (this.primaryTurnId !== null) {
      return []
    }
    const children = this.executions.workingChildren()
    const agents: AgentSessionBackgroundTask[] = children.map((child, index) => ({
      id: `codex-agent:${child.agentThreadId}`,
      kind: 'agent',
      ...(child.label ? { description: boundSubagentField(child.label, index) } : {})
    }))
    return [
      ...agents,
      ...this.commands.tasks(new Set(children.map((child) => child.agentThreadId)), (threadId) =>
        this.executions.label(threadId)
      )
    ]
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
