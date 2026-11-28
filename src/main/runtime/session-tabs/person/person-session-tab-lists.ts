// Each teammate's own tab list in a shared agent's Home (rule 4, teammate-rules.ts), first-class beside
// the host's list: its own epoch for this host process, its own monotonic version and its own saved
// row. It holds their chats, and the terminals and browser tabs they opened there. Device focus
// stays per device in ClientSessionTabSelectionStore, as for every list.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  PersistedMobileClientTabSelection,
  PersistedMobileClientTabSelections
} from '../../../../shared/orca-profiles/persisted-state-types'
import {
  isTeammateTabList,
  TEAMMATE_MOVED_HOMES_ROW,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import {
  personTabId,
  personTabListSnapshot,
  type PersonChatTabSource,
  type PersonSurface,
  type PersonSurfaceRow,
  type PersonTab,
  type PersonTabListState
} from './person-tab-list-snapshot'

type PersonTabList = PersonTabListState & { version: number }

const chatOf = (tab: PersonTab): string | null => (tab.kind === 'chat' ? tab.sessionId : null)

export class PersonSessionTabLists {
  private readonly lists = new Map<TeammateTabListKey, Map<string, PersonTabList>>()
  // Renderers order frames within one epoch, so versions only climb, across lists too.
  private clock = 0
  private readonly epoch = `person:${Date.now().toString(36)}`
  private readonly movedHomes = new Set<string>()

  constructor(private readonly persist: () => void) {}

  snapshot(
    person: TeammateTabListKey,
    worktreeId: string,
    tabOf: PersonChatTabSource,
    surfaceOf: PersonSurfaceRow
  ): RuntimeMobileSessionTabsSnapshot {
    const list = this.lists.get(person)?.get(worktreeId)
    return personTabListSnapshot(worktreeId, list, list?.version ?? this.clock, this.epoch, {
      tabOf,
      surfaceOf
    })
  }

  /** The person's chat tab, added when absent; `activate` makes it the list's pick. */
  open(person: TeammateTabListKey, worktreeId: string, sessionId: string, activate: boolean): void {
    this.add(person, worktreeId, { kind: 'chat', sessionId }, activate)
  }

  /** Stamps a terminal or page as the person's, before it exists, so no host list ever shows it. */
  openSurface(
    person: TeammateTabListKey,
    worktreeId: string,
    surface: PersonSurface,
    activate: boolean
  ): void {
    this.add(person, worktreeId, surface, activate)
  }

  /** A terminal's process, as it registers: the person whose list holds its tab, or null. */
  bindTerminal(parentTabId: string, ptyId: string): TeammateTabListKey | null {
    for (const [person, lists] of this.lists) {
      for (const [worktreeId, list] of lists) {
        const at = list.tabs.findIndex(
          (tab) => tab.kind === 'terminal' && tab.parentTabId === parentTabId
        )
        if (at !== -1) {
          const tabs = list.tabs.map((tab, index) =>
            index === at && tab.kind === 'terminal' ? { ...tab, ptyId } : tab
          )
          this.set(person, worktreeId, { ...list, tabs, version: ++this.clock })
          this.persist()
          return person
        }
      }
    }
    return null
  }

  /** Closes the tab; the closed tab, or null when the person's list in this workspace has none. */
  close(person: TeammateTabListKey, worktreeId: string, tabId: string): PersonTab | null {
    const list = this.lists.get(person)?.get(worktreeId)
    // Clients name a terminal by its tab or its pane, and a page by its id.
    const closed = list?.tabs.find(
      (tab) => personTabId(tab) === tabId || (tab.kind === 'terminal' && tab.parentTabId === tabId)
    )
    if (!list || !closed) {
      return null
    }
    const tabs = list.tabs.filter((tab) => tab !== closed)
    const ids = tabs.map(personTabId)
    const active = ids.includes(list.activeTabId ?? '') ? list.activeTabId : (ids.at(-1) ?? null)
    this.put(person, worktreeId, tabs, active)
    return closed
  }

  /** The person and workspace whose list holds a surface `matches`; null for any host surface. */
  holderOfSurface(
    matches: (surface: PersonSurface) => boolean
  ): { person: TeammateTabListKey; worktreeId: string; tabId: string } | null {
    for (const [person, lists] of this.lists) {
      for (const [worktreeId, list] of lists) {
        const held = list.tabs.find((tab) => tab.kind !== 'chat' && matches(tab))
        if (held) {
          return { person, worktreeId, tabId: personTabId(held) }
        }
      }
    }
    return null
  }

  /** The people with a list in this workspace. */
  peopleIn(worktreeId: string): TeammateTabListKey[] {
    return [...this.lists].flatMap(([person, lists]) => (lists.has(worktreeId) ? [person] : []))
  }

  /** Every terminal and page some person holds in this workspace. */
  surfacesIn(worktreeId: string): PersonSurface[] {
    return [...this.lists.values()].flatMap(
      (lists) =>
        lists.get(worktreeId)?.tabs.filter((tab): tab is PersonSurface => tab.kind !== 'chat') ?? []
    )
  }

  /** Changes whenever the list does, so a queued frame of an older list is skipped. */
  deliverySource(person: TeammateTabListKey, worktreeId: string): unknown {
    return this.lists.get(person)?.get(worktreeId) ?? this.clock
  }

  /** The people whose list in this workspace holds a chat that `holds` matches. */
  holdersOf(worktreeId: string, holds: (sessionId: string) => boolean): TeammateTabListKey[] {
    return [...this.lists].flatMap(([person, lists]) =>
      lists.get(worktreeId)?.tabs.some((tab) => {
        const sessionId = chatOf(tab)
        return sessionId !== null && holds(sessionId)
      })
        ? [person]
        : []
    )
  }

  /** What the list shows changed (a title): it moves to a new version, so clients take the frame. */
  touch(person: TeammateTabListKey, worktreeId: string): void {
    const list = this.lists.get(person)?.get(worktreeId)
    if (list) {
      this.set(person, worktreeId, { ...list, version: ++this.clock })
    }
  }

  /** The workspace is gone: every person's list there goes. */
  forgetWorktree(worktreeId: string): void {
    let changed = false
    for (const [person, lists] of this.lists) {
      changed = lists.delete(worktreeId) || changed
      if (lists.size === 0) {
        this.lists.delete(person)
      }
    }
    if (changed) {
      this.clock += 1
      this.persist()
    }
  }

  /** Teammates lost the share (one, or every teammate of the bot): their lists go. Returns the
   *  terminals and pages those lists held, which end with them. */
  forgetPeople(
    matches: (person: TeammateTabListKey) => boolean
  ): { worktreeId: string; surface: PersonSurface }[] {
    const gone = [...this.lists.keys()].filter(matches)
    if (gone.length === 0) {
      return []
    }
    const surfaces = gone.flatMap((person) =>
      [...(this.lists.get(person) ?? [])].flatMap(([worktreeId, list]) =>
        list.tabs.flatMap((tab) => (tab.kind === 'chat' ? [] : [{ worktreeId, surface: tab }]))
      )
    )
    gone.forEach((person) => this.lists.delete(person))
    this.clock += 1
    this.persist()
    return surfaces
  }

  /** Whether a Home's older-build tabs were already moved; they move once, so a tab the owner opens
   *  later in their own list is never taken for one. */
  movedHome(worktreeId: string): boolean {
    return this.movedHomes.has(worktreeId)
  }

  markHomeMoved(worktreeId: string): void {
    if (!this.movedHomes.has(worktreeId)) {
      this.movedHomes.add(worktreeId)
      this.persist()
    }
  }

  /** Saved rows ride beside the devices' selections, one row per person; see `serialize`. */
  hydrate(persisted: PersistedMobileClientTabSelections): void {
    Object.keys(persisted[TEAMMATE_MOVED_HOMES_ROW] ?? {}).forEach((home) =>
      this.movedHomes.add(home)
    )
    for (const [key, rows] of Object.entries(persisted)) {
      if (!isTeammateTabList(key)) {
        continue
      }
      for (const [worktreeId, row] of Object.entries(rows)) {
        // Rows saved before files, terminals and pages have their chats alone.
        const tabs: PersonTab[] =
          row.personTabList ??
          (row.personTabs ?? []).map((sessionId) => ({ kind: 'chat' as const, sessionId }))
        if (tabs.length > 0) {
          const active = tabs.map(personTabId).find((id) => id === row.activeTabId)
          this.set(key, worktreeId, { tabs, activeTabId: active ?? null, version: 1 })
        }
      }
    }
    this.clock = Math.max(this.clock, 1)
  }

  /** A person's row reads to an older build as a device's pick it never shows, which it keeps. */
  serialize(): PersistedMobileClientTabSelections {
    const persisted: PersistedMobileClientTabSelections = {}
    for (const [person, lists] of this.lists) {
      const rows: Record<string, PersistedMobileClientTabSelection> = {}
      for (const [worktreeId, list] of lists) {
        rows[worktreeId] = {
          activeTabId:
            list.activeTabId ?? (list.tabs.at(-1) ? personTabId(list.tabs.at(-1)!) : null),
          activeGroupId: null,
          activeTabIdByGroupId: {},
          // Builds before `personTabList` read the chats alone.
          personTabs: list.tabs.flatMap((tab) => chatOf(tab) ?? []),
          personTabList: [...list.tabs]
        }
      }
      persisted[person] = rows
    }
    if (this.movedHomes.size > 0) {
      persisted[TEAMMATE_MOVED_HOMES_ROW] = Object.fromEntries(
        // A non-null pick, so loading the saved selections keeps the row.
        [...this.movedHomes].map((home) => [
          home,
          { activeTabId: 'moved', activeGroupId: null, activeTabIdByGroupId: {} }
        ])
      )
    }
    return persisted
  }

  private add(
    person: TeammateTabListKey,
    worktreeId: string,
    tab: PersonTab,
    activate: boolean
  ): void {
    const list = this.lists.get(person)?.get(worktreeId)
    const id = personTabId(tab)
    const held = list?.tabs.some((candidate) => personTabId(candidate) === id) ?? false
    if (held && (!activate || list?.activeTabId === id)) {
      return
    }
    const tabs = held && list ? list.tabs : [...(list?.tabs ?? []), tab]
    this.put(person, worktreeId, tabs, activate ? id : (list?.activeTabId ?? id))
  }

  private put(
    person: TeammateTabListKey,
    worktreeId: string,
    tabs: readonly PersonTab[],
    activeTabId: string | null
  ): void {
    this.clock += 1
    if (tabs.length === 0) {
      const lists = this.lists.get(person)
      lists?.delete(worktreeId)
      if (lists?.size === 0) {
        this.lists.delete(person)
      }
    } else {
      this.set(person, worktreeId, { tabs, activeTabId, version: this.clock })
    }
    this.persist()
  }

  private set(person: TeammateTabListKey, worktreeId: string, list: PersonTabList): void {
    let lists = this.lists.get(person)
    if (!lists) {
      lists = new Map()
      this.lists.set(person, lists)
    }
    lists.set(worktreeId, list)
  }
}
