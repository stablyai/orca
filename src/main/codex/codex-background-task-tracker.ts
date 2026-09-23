import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  readCodexBackgroundTaskFrame,
  type CodexBackgroundTaskEvent
} from './codex-background-task-frames'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { CodexBackgroundCommandTracker } from './codex-background-command-tracker'
import { CodexChildWorkEvidence } from './codex-child-work-evidence'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import { boundSubagentField } from './codex-subagent-group-body'

/** Where a session's child-work evidence goes, and the host clock that stamps it. */
export type CodexChildWorkSink = {
  deliver: (evidence: AgentChildWorkEvidence[]) => void
  now: () => number
}

export function codexChildWorkSink(
  sessionId: string,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'onChildWorkEvidence' | 'now'>
): CodexChildWorkSink {
  return {
    deliver: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence),
    now: () => deps.now?.() ?? Date.now()
  }
}

/** Projects the same child execution facts the durable roster consumes. */
export class CodexBackgroundTaskTracker {
  private publishedFingerprint = '[]'
  private publishedState: AgentSessionBackgroundTaskState | null = null
  private readonly commands: CodexBackgroundCommandTracker
  private readonly childWork: CodexChildWorkEvidence

  constructor(
    private readonly primaryThreadId: string,
    private readonly executions = new CodexSubagentExecutions(),
    private readonly childWorkSink?: CodexChildWorkSink
  ) {
    this.commands = new CodexBackgroundCommandTracker(primaryThreadId)
    this.childWork = new CodexChildWorkEvidence(primaryThreadId, executions, (threadId) =>
      this.commands.threadTasks(threadId)
    )
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
    const command = itemEvent ? this.commands.observe(event) : null
    const frame = readCodexBackgroundTaskFrame(event, this.primaryThreadId)
    if (frame?.kind === 'subagent') {
      this.executions.register(
        frame.agentThreadId,
        frame.label,
        frame.parentTurnId,
        frame.spawnerThreadId
      )
    } else if (frame?.kind === 'turn-ended') {
      this.executions.endTurn(frame.threadId, frame.turnId, frame.state)
    } else if (frame && frame.threadId !== this.primaryThreadId) {
      this.executions.observeTurn(frame.threadId, frame.turnId, frame.state)
    }
    this.childWork.observe(event, frame, command)
    if (!frame) {
      return itemEvent ? this.refresh() : false
    }
    // A primary-turn frame only prompts a republish: turn end reveals children,
    // it never settles them. Codex `spawn_agent` children keep reporting well
    // past their parent turn, so nothing here may sweep the roster.
    return this.refresh()
  }

  clear(): boolean {
    this.executions.clear()
    this.commands.clear()
    this.childWork.clear()
    return this.refresh()
  }

  /** Everything the frames observed since the last drain said about the session's child work. */
  drainChildWorkEvidence(observedAt: number): AgentChildWorkEvidence[] {
    return this.childWork.drain(observedAt)
  }

  /** Hand the pending evidence to the host. Callers run this after the journal wrote the frame
   *  and the parent's own row republished, so a child record never lands ahead of either. */
  publishChildWork(): void {
    // Drained even with no sink, so undelivered evidence never accumulates.
    const evidence = this.drainChildWorkEvidence(this.childWorkSink?.now() ?? Date.now())
    if (evidence.length > 0) {
      this.childWorkSink?.deliver(evidence)
    }
  }

  private tasks(): AgentSessionBackgroundTask[] {
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
