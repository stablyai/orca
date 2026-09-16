import type { AgentSessionBackgroundTask } from '../../shared/agent-session-wire'
import type { CodexBackgroundTaskEvent } from './codex-background-task-frames'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import { readRecord, readString } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { MAX_CODEX_ITEM_STREAM_METADATA_BYTES } from './codex-item-stream-retention'

const MAX_SETTLED_COMMANDS = 128
const MAX_DESCRIPTION_CHARS = 512

type Command = { threadId: string; task: AgentSessionBackgroundTask; bytes: number }

/** The label's reserved share of the description. Reserved, not merely capped:
 *  a label free to spend the whole budget clips away the command it qualifies,
 *  leaving a command row naming an agent and no command — the failure this
 *  qualification exists to remove, in the other direction. `bytes` is counted
 *  before qualification, so this share is also what a published row may exceed
 *  the admitted count by. */
const MAX_LABEL_CHARS = 96

/** Every cut in this file goes through here, clipped the way `boundSubagentField`
 *  clips the same provider string on the agent row: never mid surrogate pair,
 *  since a lone surrogate is lossy through any non-JSON UTF-8 hop. A composed
 *  row is cut a SECOND time, so a clip that is safe only where the label is
 *  bounded is not safe. No ordinal, because a row's identity is its `id`. */
function boundText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  const keep = max - 1
  const last = value.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${value.slice(0, end)}…`
}

/** Resolved on read, and capped at the bound the admitted description already respects. */
function qualifiedDescription(label: string, description: string | undefined): string {
  const name = boundText(label, MAX_LABEL_CHARS)
  return boundText(description ? `${name} — ${description}` : name, MAX_DESCRIPTION_CHARS)
}

export class CodexBackgroundCommandTracker {
  private readonly commands = new Map<string, Command>()
  private readonly settled = new Map<string, number>()
  private liveBytes = 0
  private settledBytes = 0

  constructor(
    private readonly primaryThreadId: string,
    private readonly maxMetadataBytes = MAX_CODEX_ITEM_STREAM_METADATA_BYTES
  ) {}

  get retainedMetadataBytes(): number {
    return this.liveBytes + this.settledBytes
  }

  canObserve(event: CodexBackgroundTaskEvent): boolean {
    const parsed = this.parse(event)
    return (
      !parsed ||
      parsed.completed ||
      this.commands.has(parsed.key) ||
      this.settled.has(parsed.key) ||
      this.liveBytes + parsed.command.bytes <= this.maxMetadataBytes
    )
  }

  observe(event: CodexBackgroundTaskEvent): void {
    const parsed = this.parse(event)
    if (!parsed || this.settled.has(parsed.key)) {
      return
    }
    const { key, command, completed } = parsed
    const existing = this.commands.get(key)
    if (completed) {
      if (existing) {
        this.liveBytes -= existing.bytes
        this.commands.delete(key)
      }
      const bytes = Buffer.byteLength(key, 'utf8') + 256
      if (this.liveBytes + bytes <= this.maxMetadataBytes) {
        this.settled.set(key, bytes)
        this.settledBytes += bytes
      }
      this.trimSettled()
      return
    }
    if (existing) {
      return
    }
    if (this.liveBytes + command.bytes > this.maxMetadataBytes) {
      throw new Error('Codex command metadata was not admitted before observation')
    }
    this.commands.set(key, command)
    this.liveBytes += command.bytes
    this.trimSettled()
  }

  tasks(
    coveredThreads?: ReadonlySet<string>,
    childLabel?: (threadId: string) => string | null
  ): AgentSessionBackgroundTask[] {
    return [...this.commands.values()]
      .filter((command) => !coveredThreads?.has(command.threadId))
      .map(({ threadId, task }) => {
        // The agent row carrying the child's name is gone by the time this row shows;
        // unqualified it reads as a bare shell string with no owner. Resolved on read so
        // a label registered after the command still lands.
        const label = threadId === this.primaryThreadId ? null : childLabel?.(threadId)
        return label
          ? { ...task, description: qualifiedDescription(label, task.description) }
          : task
      })
  }

  clear(): void {
    this.commands.clear()
    this.settled.clear()
    this.liveBytes = 0
    this.settledBytes = 0
  }

  private trimSettled(): void {
    while (
      this.settled.size > MAX_SETTLED_COMMANDS ||
      this.retainedMetadataBytes > this.maxMetadataBytes
    ) {
      const oldest = this.settled.entries().next().value
      if (!oldest) {
        break
      }
      this.settled.delete(oldest[0])
      this.settledBytes -= oldest[1]
    }
  }

  private parse(
    event: CodexBackgroundTaskEvent
  ): { key: string; command: Command; completed: boolean } | null {
    if (event.method !== 'item/started' && event.method !== 'item/completed') {
      return null
    }
    const item = readCodexThreadItem(readRecord(event.params).item)
    if (!item || !codexCommandOutlivesTurn(item)) {
      return null
    }
    const key = JSON.stringify([event.threadId, item.id])
    const completed = event.method === 'item/completed' || item.status !== 'inProgress'
    const description = boundText(readString(item, 'command') ?? '', MAX_DESCRIPTION_CHARS)
      .replace(/\s+/g, ' ')
      .trim()
    const value = {
      threadId: event.threadId,
      task: {
        id:
          event.threadId === this.primaryThreadId
            ? `codex-command:primary:${encodeURIComponent(item.id)}`
            : `codex-command:thread:${encodeURIComponent(event.threadId)}:${encodeURIComponent(item.id)}`,
        kind: 'command' as const,
        ...(description ? { description } : {})
      }
    }
    return {
      key,
      completed,
      command: {
        ...value,
        bytes:
          Buffer.byteLength(key, 'utf8') + Buffer.byteLength(JSON.stringify(value), 'utf8') + 256
      }
    }
  }
}
