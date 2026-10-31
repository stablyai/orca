import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { StoppedSwitchSourceFact } from '../../../shared/stopped-switch-source'

type Pane = { worktreeId: string; tabId: string; leafId: string }
/** What main knows of a PTY now: a live successor on the same id ends the old process's fact. */
type CurrentPty = (
  ptyId: string
) => { connected: boolean; incarnationId?: string | null } | undefined

const paneKey = (tabId: string, leafId: string): string => `${tabId}\0${leafId}`

/**
 * The panes a switch stopped with proof and nothing replaced, kept in memory by main, which made
 * the stop. Every frame's projection publishes the field from here alone (a renderer republish
 * can neither drop nor invent it), so the window and every paired client derive the stopped pane
 * and its retry from one source. It dies when the row leaves (close, or a retry's replace) or when the pane
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

  /** Main's fact for this pane, the only source of the field a frame publishes. */
  factFor(worktreeId: string, tabId: string, leafId: string): StoppedSwitchSourceFact | undefined {
    return this.byWorkspace.get(worktreeId)?.get(paneKey(tabId, leafId))
  }

  /** Drops the facts a frame no longer backs; a workspace with none does no row pass. */
  reconcile(snapshot: RuntimeMobileSessionTabsSnapshot, current: CurrentPty): void {
    const entries = this.byWorkspace.get(snapshot.worktree)
    if (!entries) {
      return
    }
    const present = new Set<string>()
    for (const row of snapshot.tabs) {
      const key = row.type === 'terminal' ? paneKey(row.parentTabId, row.leafId) : undefined
      const fact = key ? entries.get(key) : undefined
      if (!key || !fact) {
        continue
      }
      const successor = current(fact.ptyId)
      const replaced =
        (row.type === 'terminal' && row.ptyId && row.ptyId !== fact.ptyId) ||
        (successor?.connected && successor.incarnationId !== fact.incarnationId)
      if (!replaced) {
        present.add(key)
      }
    }
    for (const key of entries.keys()) {
      if (!present.has(key)) {
        entries.delete(key)
      }
    }
    if (entries.size === 0) {
      this.byWorkspace.delete(snapshot.worktree)
    }
  }
}

type FactHost = {
  stoppedSwitchSource?(
    worktreeId: string,
    tabId: string,
    leafId: string
  ): StoppedSwitchSourceFact | undefined
}
type PaneRow = Pick<RuntimeMobileSessionTerminalTab, 'parentTabId' | 'leafId'>
const factOf = (host: FactHost, worktreeId: string, tab: PaneRow) =>
  host.stoppedSwitchSource?.(worktreeId, tab.parentTabId, tab.leafId)

/** The published field for a pane: main's fact alone, never one a renderer sent. */
export function stoppedSourceField(
  host: FactHost,
  worktreeId: string,
  tab: PaneRow
): { stoppedSwitchSource?: StoppedSwitchSourceFact } {
  const fact = factOf(host, worktreeId, tab)
  return fact ? { stoppedSwitchSource: fact } : {}
}

/**
 * The exited process a stopped row still names, so the row keeps that process's own handle: an
 * attach to it (an older client's reattach) is answered exited instead of waiting for a handle.
 */
export function stoppedSourcePty<Pty extends { incarnationId?: string | null }>(
  host: FactHost & { ptysById: ReadonlyMap<string, Pty> },
  worktreeId: string,
  tab: PaneRow
): Pty | null {
  const fact = factOf(host, worktreeId, tab)
  const pty = fact ? host.ptysById.get(fact.ptyId) : undefined
  return pty && pty.incarnationId === fact?.incarnationId ? pty : null
}
