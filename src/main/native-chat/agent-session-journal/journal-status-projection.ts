import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'

type Item = AgentJournalRenderItem
const selectors = [
  (item: Item) => item.body.kind === 'message' && item.body.role === 'user',
  (item: Item) => item.body.kind === 'message' && item.body.role === 'assistant',
  (item: Item) =>
    item.body.kind === 'message' &&
    item.body.role === 'assistant' &&
    item.body.blocks.some((block) => block.type === 'text' && block.text.trim().length > 0),
  (item: Item) => item.body.kind === 'status' && !!item.body.turnLifecycle,
  (item: Item) => item.body.kind === 'tool-call' && item.body.state === 'running',
  (item: Item) =>
    (item.body.kind === 'approval' || item.body.kind === 'question') &&
    item.body.resolution.state === 'pending'
]

/** Retains only the witnesses needed by the shared status projection. */
export class JournalStatusProjection {
  private candidates: (Item | undefined)[] = selectors.map(() => undefined)
  private dirty = true
  private cached: ReturnType<typeof projectStructuredAgentSessionStatusSummary> | undefined

  changed(item: Item | undefined, itemId: string): void {
    this.cached = undefined
    if (this.dirty) {
      return
    }
    for (let index = 0; index < selectors.length; index++) {
      const previous = this.candidates[index]
      if (previous?.itemId === itemId) {
        if (!item || !selectors[index](item)) {
          this.dirty = true
          return
        }
        this.candidates[index] = item
      } else if (item && selectors[index](item)) {
        if (previous && item.sequence === previous.sequence) {
          // Batch members share a sequence; recover their stable map order on the next read.
          this.dirty = true
          return
        }
        if (!previous || item.sequence > previous.sequence) {
          this.candidates[index] = item
        }
      }
    }
  }

  read(
    items: ReadonlyMap<string, Item>
  ): ReturnType<typeof projectStructuredAgentSessionStatusSummary> {
    if (this.cached) {
      return this.cached
    }
    if (this.dirty) {
      this.candidates = selectors.map(() => undefined)
      for (const item of items.values()) {
        for (let index = 0; index < selectors.length; index++) {
          const previous = this.candidates[index]
          if (selectors[index](item) && (!previous || item.sequence >= previous.sequence)) {
            this.candidates[index] = item
          }
        }
      }
      this.dirty = false
    }
    let selected = [...new Set(this.candidates.filter((item): item is Item => !!item))]
    if (new Set(selected.map((item) => item.sequence)).size !== selected.length) {
      const ids = new Set(selected.map((item) => item.itemId))
      selected = []
      for (const item of items.values()) {
        if (ids.has(item.itemId)) {
          selected.push(item)
        }
      }
    }
    selected.sort((a, b) => a.sequence - b.sequence)
    this.cached = projectStructuredAgentSessionStatusSummary(selected)
    return this.cached
  }
}
