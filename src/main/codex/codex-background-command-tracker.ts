import type { AgentSessionBackgroundTask } from '../../shared/agent-session-wire'
import {
  boundCodexCommandDescription,
  codexChildCommandDescription
} from '../../shared/codex-child-command-description'
import type { CodexBackgroundTaskEvent } from './codex-background-task-frames'
import { readRecord, readString } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import type { CodexAbandonedCommand } from './codex-prompt-registry'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { codexPrimaryCommandTaskId } from '../../shared/structured-session-foreground-commands'

const MAX_SETTLED_COMMANDS = 128

type Command = {
  threadId: string
  turnId: string | null
  backgrounded: boolean
  task: AgentSessionBackgroundTask
  /** Codex's id for the command's process, which a background-terminal stop names. */
  processId?: string
}

export type CodexBackgroundCommandChange =
  | {
      type: 'started'
      threadId: string
      turnId: string | null
      backgrounded: boolean
      task: AgentSessionBackgroundTask
      processId?: string
    }
  | { type: 'ended'; threadId: string; taskId: string }

export class CodexBackgroundCommandTracker {
  private readonly commands = new Map<string, Command>()
  private readonly settled = new Set<string>()

  constructor(private readonly primaryThreadId: string) {}

  observe(event: CodexBackgroundTaskEvent): CodexBackgroundCommandChange | null {
    const parsed = this.parse(event)
    if (!parsed || this.settled.has(parsed.key)) {
      return null
    }
    const { key, command, completed } = parsed
    if (completed) {
      return this.end(key)
    }
    if (this.commands.has(key)) {
      return null
    }
    this.commands.set(key, command)
    return this.liveChange(command)
  }

  /** A surviving process becomes background work when the turn that launched it ends. */
  endTurn(threadId: string, turnId: string): CodexBackgroundCommandChange[] {
    const backgrounded: CodexBackgroundCommandChange[] = []
    for (const command of this.commands.values()) {
      if (
        command.threadId === threadId &&
        (command.turnId === turnId || command.turnId === null) &&
        !command.backgrounded
      ) {
        command.backgrounded = true
        backgrounded.push(this.liveChange(command))
      }
    }
    this.rememberSettled(this.turnKey(threadId, turnId))
    return backgrounded
  }

  private liveChange(command: Command): Extract<CodexBackgroundCommandChange, { type: 'started' }> {
    const { threadId, turnId, backgrounded, task, processId } = command
    return {
      type: 'started',
      threadId,
      turnId,
      backgrounded,
      task,
      ...(processId !== undefined ? { processId } : {})
    }
  }

  /** The thread closed: Codex stops its processes first, so none of them can report an exit. */
  endThread(threadId: string): CodexBackgroundCommandChange[] {
    return [...this.commands]
      .filter(([, command]) => command.threadId === threadId)
      .flatMap(([key]) => this.end(key) ?? [])
  }

  /** Its approval went unanswered until its turn ended, so its process never started. */
  endUnapproved(command: CodexAbandonedCommand): CodexBackgroundCommandChange | null {
    return this.end(JSON.stringify([command.threadId, command.itemId]))
  }

  tasks(
    coveredThreads?: ReadonlySet<string>,
    childLabel?: (threadId: string) => string | null
  ): AgentSessionBackgroundTask[] {
    return [...this.commands.values()]
      .filter((command) => command.backgrounded && !coveredThreads?.has(command.threadId))
      .map(({ threadId, task }) => {
        // Qualify orphaned command rows on read so labels arriving after the command still apply.
        const label = threadId === this.primaryThreadId ? null : childLabel?.(threadId)
        return label
          ? { ...task, description: codexChildCommandDescription(label, task.description) }
          : task
      })
  }

  get holdsProcess(): boolean {
    return [...this.commands.values()].some((command) => command.processId !== undefined)
  }

  liveCommands(): CodexBackgroundCommandChange[] {
    return [...this.commands.values()].map((command) => this.liveChange(command))
  }

  /** Only backgrounded commands have rows the user can stop. */
  backgroundProcesses(taskIds: readonly string[]): { threadId: string; processId: string }[] {
    const named = new Set(taskIds)
    return [...this.commands.values()].flatMap(({ threadId, backgrounded, task, processId }) =>
      backgrounded && processId !== undefined && named.has(task.id) ? [{ threadId, processId }] : []
    )
  }

  /** Live processes, including foreground tools that are absent from the strip. */
  threadCommands(threadId: string): CodexBackgroundCommandChange[] {
    return [...this.commands.values()]
      .filter((command) => command.threadId === threadId)
      .map((command) => this.liveChange(command))
  }

  clear(): CodexBackgroundCommandChange[] {
    const ended = [...this.commands.values()].map(
      ({ threadId, task }): CodexBackgroundCommandChange => ({
        type: 'ended',
        threadId,
        taskId: task.id
      })
    )
    this.commands.clear()
    this.settled.clear()
    return ended
  }

  /** Retires the key so a replayed frame cannot start the command again. */
  private end(key: string): CodexBackgroundCommandChange | null {
    const existing = this.commands.get(key)
    if (existing) {
      this.commands.delete(key)
    }
    this.rememberSettled(key)
    return existing
      ? { type: 'ended', threadId: existing.threadId, taskId: existing.task.id }
      : null
  }

  private turnKey(threadId: string, turnId: string): string {
    return JSON.stringify(['turn', threadId, turnId])
  }

  private rememberSettled(key: string): void {
    this.settled.add(key)
    if (this.settled.size > MAX_SETTLED_COMMANDS) {
      const oldest = this.settled.values().next().value
      if (oldest !== undefined) {
        this.settled.delete(oldest)
      }
    }
  }

  private parse(
    event: CodexBackgroundTaskEvent
  ): { key: string; command: Command; completed: boolean } | null {
    if (event.method !== 'item/started' && event.method !== 'item/completed') {
      return null
    }
    // Track every process; a stdin write reaches one already tracked.
    const item = readCodexThreadItem(readRecord(event.params).item)
    if (item?.type !== 'commandExecution' || item.source === 'unifiedExecInteraction') {
      return null
    }
    const key = JSON.stringify([event.threadId, item.id])
    const completed = event.method === 'item/completed' || item.status !== 'inProgress'
    const description = boundCodexCommandDescription(readString(item, 'command') ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const turnId = readCodexTurnId(event.params)
    const processId = readString(item, 'processId') ?? undefined
    const command = {
      threadId: event.threadId,
      turnId,
      backgrounded: turnId !== null && this.settled.has(this.turnKey(event.threadId, turnId)),
      task: {
        id:
          event.threadId === this.primaryThreadId
            ? codexPrimaryCommandTaskId(item.id)
            : `codex-command:thread:${encodeURIComponent(event.threadId)}:${encodeURIComponent(item.id)}`,
        kind: 'command' as const,
        ...(description ? { description } : {})
      },
      ...(processId !== undefined ? { processId } : {})
    }
    return { key, completed, command }
  }
}
