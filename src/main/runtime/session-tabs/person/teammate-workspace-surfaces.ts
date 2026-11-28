import { randomUUID } from 'node:crypto'
import { mintServePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
// Which tab list a terminal or page belongs to, by the stamp on its record (`holder`): the host's
// lists hold none of a teammate's, and a teammate's own workspace none of the host's.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { TeammateTabListKey } from '../../../bots/team-share/teammate-rules'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { withoutHeldTabs } from './person-surface-rows'
import { holderOfTabList, tabListOfPty } from './person-workspace-target'

type Stamped = Parameters<typeof tabListOfPty>[0]

/** A list keeps only its own terminals and pages; a record not yet made stays where it is. */
export function withOwnSurfacesOnly(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  ptyOf: (ptyId: string) => Stamped | undefined,
  pageOf: (
    browserPageId: string
  ) => { workspaceId: string; holder?: TeammateTabListKey } | undefined
): RuntimeMobileSessionTabsSnapshot {
  const elsewhere = (record: Stamped | undefined) =>
    record !== undefined && tabListOfPty(record) !== snapshot.worktree
  return withoutHeldTabs(snapshot, (tab) => {
    if (tab.type === 'terminal') {
      return Boolean(tab.ptyId && elsewhere(ptyOf(tab.ptyId)))
    }
    const page = tab.type === 'browser' && tab.browserPageId ? pageOf(tab.browserPageId) : undefined
    return Boolean(page && elsewhere({ worktreeId: page.workspaceId, holder: page.holder }))
  })
}

/** The stamp a terminal's record takes when it is made: the teammate whose workspace holds it,
 *  starting (by the id it starts under, so whichever path records its process first stamps it) or
 *  restored (its tab in their workspace's snapshot). */
export class HeldTerminalStamps {
  /** A page or terminal by the id it starts under, until its list holds it. */
  startingHolder(id: string): TeammateTabListKey | undefined {
    return this.starting.get(id)
  }

  private readonly starting = new Map<string, TeammateTabListKey>()

  async whileStarting<T>(
    ptyId: string | undefined,
    holder: TeammateTabListKey | undefined,
    start: () => Promise<T>
  ): Promise<T> {
    const release = this.hold(ptyId, holder)
    try {
      return await start()
    } finally {
      release()
    }
  }

  /** Holds the stamp until the returned release. */
  hold(id: string | undefined, holder: TeammateTabListKey | undefined): () => void {
    if (!id || !holder) {
      return () => {}
    }
    this.starting.set(id, holder)
    return () => this.starting.delete(id)
  }

  stampOf(
    ptyId: string,
    snapshots: { worktreeIdsForPty(ptyId: string): Iterable<string> },
    saved: WorkspaceSessionState | undefined
  ): TeammateTabListKey | undefined {
    const starting = this.starting.get(ptyId)
    if (starting) {
      return starting
    }
    const lists = [...snapshots.worktreeIdsForPty(ptyId), ...savedListsBinding(saved, ptyId)]
    return lists.map((list) => holderOfTabList(list).holder).find(Boolean)
  }
}

/** The teammates' workspaces whose saved layout binds this PTY: a terminal the daemon kept across a
 *  host restart, before their workspace is read again. */
function savedListsBinding(saved: WorkspaceSessionState | undefined, ptyId: string): string[] {
  const tabIds = Object.entries(saved?.terminalLayoutsByTabId ?? {}).flatMap(([tabId, layout]) =>
    Object.values(layout.ptyIdsByLeafId ?? {}).includes(ptyId) ? [tabId] : []
  )
  return tabIds.length === 0
    ? []
    : Object.entries(saved?.tabsByWorktree ?? {}).flatMap(([list, tabs]) =>
        tabs.some((tab) => tabIds.includes(tab.id)) ? [list] : []
      )
}

/** The teammate a saved page belongs to: the one whose own workspace saved it before a restart. */
export function savedPageHolder(
  saved: WorkspaceSessionState | undefined,
  browserPageId: string
): TeammateTabListKey | undefined {
  const lists = Object.entries(saved?.clientHostedBrowserPagesByWorktree ?? {})
  const list = lists.find(([, rows]) => rows.some((row) => row.browserPageId === browserPageId))
  return list ? holderOfTabList(list[0]).holder : undefined
}

/** The teammate a page is published for: opened in their own workspace, or saved there before a
 *  restart. */
export function heldPageOf(
  starts: HeldTerminalStamps,
  store: { getWorkspaceSession?(partition: string): WorkspaceSessionState } | null | undefined,
  browserPageId: string
): TeammateTabListKey | null {
  return (
    starts.startingHolder(browserPageId) ??
    savedPageHolder(
      store?.getWorkspaceSession?.(TEAMMATE_HOMES_SESSION_PARTITION),
      browserPageId
    ) ??
    null
  )
}

/** A teammate's terminal starts under an id of its own (a local Home's daemon reattaches it by it),
 *  so whichever path records its process first stamps it as theirs. */
export function heldTerminalCreate<O extends { holder?: TeammateTabListKey; sessionId?: string }>(
  workspace: { id: string; connectionId?: string | null },
  opts: O
): O {
  return opts.holder && !opts.sessionId && !workspace.connectionId
    ? { ...opts, sessionId: mintServePtySessionId(workspace.id, randomUUID()), isNewSession: true }
    : opts
}
