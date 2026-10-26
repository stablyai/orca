import { isSettledBackgroundTaskState } from '../../shared/native-chat-background-task-row'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'

const MAX_GENERATION_ENTRIES = 512
const MAX_FOREIGN_TASK_ROWS = 512
const MAX_TERMINAL_TASK_IDS = 512
const MAX_FALLBACK_TASK_IDS = 512

// Monotonic generations prevent reused, evicted IDs from overwriting durable rows.
class ClaudeBackgroundTaskGenerationLedger {
  private readonly entries = new Map<string, number>()
  private nextUniqueGeneration = 1
  private evicted = false

  next(id: string): number {
    const previous = this.entries.get(id)
    const generation =
      previous === undefined ? (this.evicted ? this.nextUniqueGeneration++ : 1) : previous + 1
    this.entries.delete(id)
    this.entries.set(id, generation)
    this.nextUniqueGeneration = Math.max(this.nextUniqueGeneration, generation + 1)
    while (this.entries.size > MAX_GENERATION_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done || oldest.value === id) {
        break
      }
      this.entries.delete(oldest.value)
      this.evicted = true
    }
    return generation
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.nextUniqueGeneration = 1
    this.evicted = false
  }
}

function rememberBoundedClaudeTaskSet(ids: Set<string>, id: string, maxSize: number): void {
  ids.delete(id)
  ids.add(id)
  while (ids.size > maxSize) {
    const oldest = ids.values().next()
    if (oldest.done || oldest.value === id) {
      break
    }
    ids.delete(oldest.value)
  }
}

function rememberBoundedClaudeTaskMap<T>(
  entries: Map<string, T>,
  id: string,
  value: T,
  maxSize: number
): void {
  entries.delete(id)
  entries.set(id, value)
  while (entries.size > maxSize) {
    const oldest = entries.keys().next()
    if (oldest.done || oldest.value === id) {
      break
    }
    entries.delete(oldest.value)
  }
}

export function ensureClaudeBackgroundTaskRowSlot(
  rows: Map<string, ClaudeBackgroundTaskRow>,
  maxSize: number
): boolean {
  if (rows.size < maxSize) {
    return true
  }
  for (const [id, row] of rows) {
    if (isSettledBackgroundTaskState(row.block.state)) {
      rows.delete(id)
      return true
    }
  }
  return false
}

function rememberClaudeBackgroundTaskTerminal(
  terminalIds: Set<string>,
  terminalToolUseIds: Map<string, string | undefined>,
  rows: Map<string, ClaudeBackgroundTaskRow>,
  id: string,
  toolUseId: string | undefined,
  maxSize: number
): void {
  terminalIds.delete(id)
  terminalIds.add(id)
  terminalToolUseIds.set(id, toolUseId ?? rows.get(id)?.toolUseId ?? terminalToolUseIds.get(id))
  while (terminalIds.size > maxSize) {
    const oldest = terminalIds.values().next()
    if (oldest.done || oldest.value === id) {
      break
    }
    terminalToolUseIds.delete(oldest.value)
    terminalIds.delete(oldest.value)
  }
}

/** sidechain belongs to a nested run; terminal already emitted its outcome without a live slot. */
export type ForeignOwner = 'roster' | 'ambient' | 'foreground' | 'sidechain' | 'terminal'

export type ClaudeBackgroundTaskLedgerSizes = {
  readonly generations: number
  readonly foreign: number
  readonly fallbackTaskIds: number
  readonly terminalTaskIds: number
}

export class ClaudeBackgroundTaskLedgers {
  /** Run identity survives row eviction so restarts cannot overwrite history. */
  readonly generations = new ClaudeBackgroundTaskGenerationLedger()
  readonly foreign = new Map<string, ForeignOwner>()
  /** Capacity-refused tasks retain generic fallback coverage. */
  readonly fallbackTaskIds = new Set<string>()
  readonly terminalTaskIds = new Set<string>()
  /** Retain the terminal parent alias after eviction to distinguish redelivery from a restart. */
  readonly terminalToolUseIds = new Map<string, string | undefined>()

  rememberForeign(id: string, owner: ForeignOwner): void {
    rememberBoundedClaudeTaskMap(this.foreign, id, owner, MAX_FOREIGN_TASK_ROWS)
  }

  rememberFallback(id: string): void {
    rememberBoundedClaudeTaskSet(this.fallbackTaskIds, id, MAX_FALLBACK_TASK_IDS)
  }

  rememberTerminal(
    rows: Map<string, ClaudeBackgroundTaskRow>,
    id: string,
    toolUseId: string | undefined
  ): void {
    rememberClaudeBackgroundTaskTerminal(
      this.terminalTaskIds,
      this.terminalToolUseIds,
      rows,
      id,
      toolUseId,
      MAX_TERMINAL_TASK_IDS
    )
  }

  get sizes(): ClaudeBackgroundTaskLedgerSizes {
    return {
      generations: this.generations.size,
      foreign: this.foreign.size,
      fallbackTaskIds: this.fallbackTaskIds.size,
      terminalTaskIds: this.terminalTaskIds.size
    }
  }

  clear(): void {
    this.generations.clear()
    this.foreign.clear()
    this.fallbackTaskIds.clear()
    this.terminalTaskIds.clear()
    this.terminalToolUseIds.clear()
  }
}
