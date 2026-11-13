import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { journalItemExecutionFence } from '../projection/journal-item-provenance'

type Tool = { name: string; startedAt: number }
type Calls = { items: Map<string, Tool>; oldest?: Tool }

/** Derived beside the input order so rollback and history adoption retain the same facts. */
export class JournalRunningTools {
  private readonly owners = new Map<string, string>()
  private readonly calls = new Map<string, Calls>()

  constructor(state: JournalReducerState) {
    for (const item of state.items.values()) {
      this.refresh(state, item.itemId, item)
    }
  }

  oldest(turnItemId: string, fence: number): Tool | undefined {
    const calls = this.calls.get(JSON.stringify([turnItemId, fence]))
    if (calls && !calls.oldest) {
      for (const tool of calls.items.values()) {
        if (!calls.oldest || tool.startedAt < calls.oldest.startedAt) {
          calls.oldest = tool
        }
      }
    }
    return calls?.oldest
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    const ids =
      row.kind === 'item' || row.kind === 'tombstone'
        ? [row.itemId]
        : row.kind === 'lifecycle-batch'
          ? row.mutations.map((mutation) => mutation.itemId)
          : []
    for (const raw of ids) {
      const id = state.aliases.get(raw) ?? raw
      this.refresh(state, id, state.items.get(id))
    }
  }

  private refresh(state: JournalReducerState, id: string, item?: AgentJournalRenderItem): void {
    const scope = item?.turnScope
    const body = item?.body
    const fence = journalItemExecutionFence(state, id)
    const key =
      body?.kind === 'tool-call' && body.state === 'running' && scope?.kind === 'turn'
        ? JSON.stringify([scope.turnItemId, fence])
        : undefined
    const previous = this.owners.get(id)
    if (previous !== undefined) {
      const calls = this.calls.get(previous)!
      if (calls.oldest === calls.items.get(id)) {
        calls.oldest = undefined
      }
      if (previous !== key) {
        calls.items.delete(id)
        this.owners.delete(id)
        if (calls.items.size === 0) {
          this.calls.delete(previous)
        }
      }
    }
    if (key !== undefined && body?.kind === 'tool-call' && item) {
      let calls = this.calls.get(key)
      if (!calls) {
        calls = { items: new Map() }
        this.calls.set(key, calls)
      }
      const tool = { name: body.name, startedAt: item.observedAt }
      calls.items.set(id, tool)
      if (calls.oldest && tool.startedAt < calls.oldest.startedAt) {
        calls.oldest = tool
      }
      this.owners.set(id, key)
    }
  }
}
