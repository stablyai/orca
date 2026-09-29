import { isSettledBackgroundTaskState } from '../../shared/native-chat-background-task-row'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'

const MAX_GENERATION_ENTRIES = 512
const MAX_FOREIGN_TASK_ROWS = 512
const MAX_TERMINAL_TASK_IDS = 512
const MAX_FALLBACK_TASK_IDS = 512

/** Bounded run identity ledger. Once old ids fall out, a monotonic sequence
 * keeps a reused id from colliding with a durable row already in the journal. */
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

/** Who renders a task this owner deliberately declined.
 *
 *  `sidechain` is a Task spawned inside a subagent's own run: its spawning tool
 *  never reached the top-level transcript, so no top-level row may claim it.
 *  `terminal` is a capacity-refused task whose settled typed row was already
 *  written without taking a live slot; its redeliveries must not print again. */
export type ForeignOwner = 'roster' | 'ambient' | 'foreground' | 'sidechain' | 'terminal'

/** How much each ledger is holding. Named and readonly so a caller can prove
 *  eviction still bounds them without reaching into the collections. */
export type ClaudeBackgroundTaskLedgerSizes = {
  readonly generations: number
  readonly foreign: number
  readonly fallbackTaskIds: number
  readonly terminalTaskIds: number
}

/** Every bounded ledger a session keeps beside its rows, with the caps that
 *  bound them. One owner, so a sweep clears them together and no cap is
 *  applied at only some of the call sites that write to a ledger. */
export class ClaudeBackgroundTaskLedgers {
  /** Runs seen per task id, so a reused id opens a new row instead of
   *  overwriting the finished one. Survives the row being evicted. */
  readonly generations = new ClaudeBackgroundTaskGenerationLedger()
  readonly foreign = new Map<string, ForeignOwner>()
  /** Tasks that were declined because every typed row slot was live. Their
   *  later frames must remain visible through the generic fallback. */
  readonly fallbackTaskIds = new Set<string>()
  readonly terminalTaskIds = new Set<string>()
  /** The parent alias for the terminal run, when one was reported. Keeping it
   *  lets an evicted row distinguish a late duplicate start from a genuine
   *  restart under a fresh tool invocation. */
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
