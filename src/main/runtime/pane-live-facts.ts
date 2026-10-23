// A fact about a pane's terminal that main lays over the published layout (layout-owner build):
// live state, never saved, that lasts only while the binding it was first published with stands,
// so any later bind ends it. Keys are never reused.

/** A pane's terminal binding as published: its terminal and that terminal's bind generation. */
export function bindingOf(pane: { ptyId?: string; ptyGeneration?: number }): string {
  return `${pane.ptyId ?? ''}#${pane.ptyGeneration ?? ''}`
}

/** A bind the fact waits for: to `ptyId`, at a generation above `afterGeneration` when given. */
export type AwaitedBind = { ptyId: string; afterGeneration?: number }

function isAwaitedBind(binding: string, { ptyId, afterGeneration }: AwaitedBind): boolean {
  const prefix = `${ptyId}#`
  return (
    binding.startsWith(prefix) &&
    (afterGeneration === undefined || Number(binding.slice(prefix.length)) > afterGeneration)
  )
}

export class PaneLiveFacts<T> {
  private readonly byPaneKey = new Map<
    string,
    { fact: T; awaits?: AwaitedBind; binding?: string }
  >()

  constructor(private readonly changed: () => void) {}

  /** With `awaits`, the fact shows only once the pane binds that terminal. */
  set(paneKey: string, fact: T, awaits?: AwaitedBind): void {
    this.byPaneKey.set(paneKey, { fact, ...(awaits ? { awaits } : {}) })
    this.changed()
  }

  clear(paneKey: string): void {
    if (this.byPaneKey.delete(paneKey)) {
      this.changed()
    }
  }

  /** The fact as set, without pinning it to a binding (tests and logs). */
  peek(paneKey: string): T | null {
    return this.byPaneKey.get(paneKey)?.fact ?? null
  }

  /** The fact while the pane keeps the binding it was first published with; a new bind ends it. */
  get(paneKey: string, binding: string): T | null {
    const entry = this.byPaneKey.get(paneKey)
    if (!entry) {
      return null
    }
    // Why not ended: the start's own bind may not have landed yet (a same-id respawn included).
    if (entry.binding === undefined && entry.awaits && !isAwaitedBind(binding, entry.awaits)) {
      return null
    }
    entry.binding ??= binding
    if (entry.binding !== binding) {
      this.byPaneKey.delete(paneKey)
      return null
    }
    return entry.fact
  }
}
