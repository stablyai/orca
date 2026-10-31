import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { StoppedSwitchSourceFact } from '../../../shared/stopped-switch-source'

type Row = RuntimeMobileSessionTabsSnapshot['tabs'][number]
type Pane = { worktreeId: string; tabId: string; leafId: string }
/** What main knows of a PTY now: a live successor on the same id ends the old process's fact. */
type CurrentPty = (
  ptyId: string
) => { connected: boolean; incarnationId?: string | null } | undefined

const paneKey = (tabId: string, leafId: string): string => `${tabId}\0${leafId}`

/**
 * The panes a switch stopped with proof and nothing replaced, kept in memory by main, which made
 * the stop. Every frame carries the fact on that pane's row (a renderer republish can neither drop
 * nor invent it), so the window and every paired client derive the stopped pane and its retry
 * from one source. It dies when the row leaves (close, or a retry's replace) or when the pane
 * names another process (Restart, a rebind, a successor on the same PTY id).
 */
export class StoppedSwitchSourceFacts {
  private readonly byWorkspace = new Map<string, Map<string, StoppedSwitchSourceFact>>()

  record(pane: Pane, fact: StoppedSwitchSourceFact): void {
    const entries = this.byWorkspace.get(pane.worktreeId) ?? new Map()
    this.byWorkspace.set(pane.worktreeId, entries)
    entries.set(paneKey(pane.tabId, pane.leafId), fact)
  }

  /** Whether this exact process is a stopped switch source; an unknown incarnation never is. */
  stoppedProcess(ptyId: string, incarnationId: string | null | undefined): boolean {
    for (const entries of this.byWorkspace.values()) {
      for (const fact of entries.values()) {
        if (fact.ptyId === ptyId && fact.incarnationId === incarnationId) {
          return true
        }
      }
    }
    return false
  }

  /** One pass over the frame's rows; a workspace with no fact and no stray field costs one scan. */
  stamp(snapshot: RuntimeMobileSessionTabsSnapshot, current: CurrentPty) {
    const entries = this.byWorkspace.get(snapshot.worktree)
    const present = new Set<string>()
    let tabs: Row[] | undefined
    snapshot.tabs.forEach((row, index) => {
      if (row.type !== 'terminal') {
        return
      }
      const key = paneKey(row.parentTabId, row.leafId)
      let fact = entries?.get(key)
      const successor = fact && current(fact.ptyId)
      if (
        fact &&
        ((row.ptyId && row.ptyId !== fact.ptyId) ||
          (successor?.connected && successor.incarnationId !== fact.incarnationId))
      ) {
        entries!.delete(key)
        fact = undefined
      }
      if (fact) {
        present.add(key)
      }
      if (row.stoppedSwitchSource === fact) {
        return
      }
      const { stoppedSwitchSource: _dropped, ...rest } = row
      const next: RuntimeMobileSessionTerminalTab = fact
        ? { ...rest, stoppedSwitchSource: fact }
        : rest
      tabs ??= [...snapshot.tabs]
      tabs[index] = next
    })
    for (const key of entries?.keys() ?? []) {
      if (!present.has(key)) {
        entries!.delete(key)
      }
    }
    if (entries?.size === 0) {
      this.byWorkspace.delete(snapshot.worktree)
    }
    return tabs ? { ...snapshot, tabs } : snapshot
  }
}

/**
 * The exited process a stopped row still names, so the row keeps that process's own handle: an
 * attach to it (an older client's reattach) is answered exited instead of waiting for a handle.
 */
export function stoppedSwitchSourcePty<Pty extends { incarnationId?: string | null }>(
  row: Pick<RuntimeMobileSessionTerminalTab, 'stoppedSwitchSource'>,
  ptysById: ReadonlyMap<string, Pty>
): Pty | null {
  const fact = row.stoppedSwitchSource
  const pty = fact ? ptysById.get(fact.ptyId) : undefined
  return pty && pty.incarnationId === fact?.incarnationId ? pty : null
}
