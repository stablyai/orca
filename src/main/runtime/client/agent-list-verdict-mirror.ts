import { isDeepStrictEqual } from 'node:util'
import type {
  AgentListPublication,
  AgentListVerdictUpdate
} from '../../../shared/agent-status/presentation/agent-list-status'

/** Changed pane keys; null when any pane may have changed. */
export type AgentListChangeListener = (paneKeys: ReadonlySet<string> | null) => void

/** Main's copy of the window's Agents-list verdicts, kept from its resets and changes. */
export class AgentListVerdictMirror {
  private publication: AgentListPublication | null = null
  // A reloading window's list is hidden, not dropped, so a cancelled reload keeps what it sent.
  private withheld = false
  private readonly listeners = new Set<AgentListChangeListener>()

  constructor(private readonly onChanged: () => void) {}

  read(): AgentListPublication | null {
    return this.withheld ? null : this.publication
  }

  subscribe(listener: AgentListChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The whole list, or null with no window to publish it. */
  set(next: AgentListPublication | null): void {
    const changed = !isDeepStrictEqual(this.read()?.verdicts, next?.verdicts)
    this.publication = next
    this.withheld = false
    if (changed) {
      this.emit(null)
    }
  }

  apply(update: AgentListVerdictUpdate | null): void {
    if (update?.kind !== 'changes') {
      this.set(update?.publication ?? null)
      return
    }
    // Every document resets first; changes without a base have nothing to apply to.
    if (!this.publication) {
      return
    }
    // Owned: the publication came over IPC, and readers look verdicts up on each read.
    const { verdicts } = this.publication
    const paneKeys = new Set<string>()
    for (const [paneKey, verdict] of Object.entries(update.changed)) {
      verdicts[paneKey] = verdict
      paneKeys.add(paneKey)
    }
    for (const paneKey of update.removed) {
      delete verdicts[paneKey]
      paneKeys.add(paneKey)
    }
    this.publication.publishedAt = update.publishedAt
    if (paneKeys.size > 0 && !this.withheld) {
      this.emit(paneKeys)
    }
  }

  withhold(): void {
    const visible = this.read()
    this.withheld = true
    if (visible) {
      this.emit(null)
    }
  }

  /** A cancelled reload shows the surviving document's list again. */
  restore(): void {
    if (this.withheld) {
      this.withheld = false
      if (this.publication) {
        this.emit(null)
      }
    }
  }

  private emit(paneKeys: ReadonlySet<string> | null): void {
    this.onChanged()
    for (const listener of this.listeners) {
      listener(paneKeys)
    }
  }
}
