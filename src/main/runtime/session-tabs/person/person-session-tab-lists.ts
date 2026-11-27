// Each teammate's own tab list in a shared agent's Home (rule 4, teammate-rules.ts), first-class beside
// the host's list: its own epoch for this host process, its own monotonic version and its own saved
// row. It holds chats only. Device focus stays per device in ClientSessionTabSelectionStore, as for
// every list.
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { RuntimeMobileSessionAgentTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
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
import { getHeadlessMobileSessionGroupId } from '../../terminal/surface/mobile-session-layout-projection'

/** What a person's chat tab shows, read from the chat's record; null when it is gone. */
export type PersonChatTabSource = (
  worktreeId: string,
  sessionId: string
) => { agent: StructuredAgentId; title: string; forked?: true } | null

type PersonTabList = {
  sessionIds: readonly string[]
  activeSessionId: string | null
  version: number
}

export function personChatTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

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
    tabOf: PersonChatTabSource
  ): RuntimeMobileSessionTabsSnapshot {
    const list = this.lists.get(person)?.get(worktreeId)
    const tabs = (list?.sessionIds ?? []).flatMap((sessionId): RuntimeMobileSessionAgentTab[] => {
      const shown = tabOf(worktreeId, sessionId)
      return shown
        ? [
            {
              type: 'agent-session',
              id: personChatTabId(sessionId),
              title: shown.title,
              sessionId,
              agent: shown.agent,
              ...(shown.forked ? { forked: true as const } : {}),
              isActive: sessionId === list?.activeSessionId
            }
          ]
        : []
    })
    const active = tabs.find((tab) => tab.isActive) ?? null
    const groupId = getHeadlessMobileSessionGroupId(worktreeId)
    return {
      worktree: worktreeId,
      publicationEpoch: this.epoch,
      snapshotVersion: list?.version ?? this.clock,
      activeGroupId: tabs.length > 0 ? groupId : null,
      activeTabId: active?.id ?? null,
      activeTabType: active ? 'agent-session' : null,
      tabGroups:
        tabs.length > 0
          ? [{ id: groupId, activeTabId: active?.id ?? null, tabOrder: tabs.map((tab) => tab.id) }]
          : [],
      tabs
    }
  }

  /** The person's chat tab, added when absent; `activate` makes it the list's pick. */
  open(person: TeammateTabListKey, worktreeId: string, sessionId: string, activate: boolean): void {
    const list = this.lists.get(person)?.get(worktreeId)
    const held = list?.sessionIds.includes(sessionId) ?? false
    if (held && (!activate || list?.activeSessionId === sessionId)) {
      return
    }
    const sessionIds = held && list ? list.sessionIds : [...(list?.sessionIds ?? []), sessionId]
    this.put(
      person,
      worktreeId,
      sessionIds,
      activate ? sessionId : (list?.activeSessionId ?? sessionId)
    )
  }

  /** Closes the tab; false when the person's list in this workspace has no such tab. */
  close(person: TeammateTabListKey, worktreeId: string, tabId: string): boolean {
    const list = this.lists.get(person)?.get(worktreeId)
    const sessionIds = list?.sessionIds.filter((sessionId) => personChatTabId(sessionId) !== tabId)
    if (!list || !sessionIds || sessionIds.length === list.sessionIds.length) {
      return false
    }
    const active = sessionIds.includes(list.activeSessionId ?? '')
      ? list.activeSessionId
      : (sessionIds.at(-1) ?? null)
    this.put(person, worktreeId, sessionIds, active)
    return true
  }

  /** Changes whenever the list does, so a queued frame of an older list is skipped. */
  deliverySource(person: TeammateTabListKey, worktreeId: string): unknown {
    return this.lists.get(person)?.get(worktreeId) ?? this.clock
  }

  /** The people whose list in this workspace holds a chat that `holds` matches. */
  holdersOf(worktreeId: string, holds: (sessionId: string) => boolean): TeammateTabListKey[] {
    return [...this.lists].flatMap(([person, lists]) =>
      lists.get(worktreeId)?.sessionIds.some(holds) ? [person] : []
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

  /** Teammates lost the share (one, or every teammate of the bot): their lists go. */
  forgetPeople(matches: (person: TeammateTabListKey) => boolean): void {
    const gone = [...this.lists.keys()].filter(matches)
    if (gone.length === 0) {
      return
    }
    gone.forEach((person) => this.lists.delete(person))
    this.clock += 1
    this.persist()
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
        const sessionIds = row.personTabs ?? []
        if (sessionIds.length > 0) {
          const active = sessionIds.find(
            (sessionId) => personChatTabId(sessionId) === row.activeTabId
          )
          this.set(key, worktreeId, { sessionIds, activeSessionId: active ?? null, version: 1 })
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
        const active = list.activeSessionId ?? list.sessionIds.at(-1) ?? null
        rows[worktreeId] = {
          activeTabId: active ? personChatTabId(active) : null,
          activeGroupId: null,
          activeTabIdByGroupId: {},
          personTabs: [...list.sessionIds]
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

  private put(
    person: TeammateTabListKey,
    worktreeId: string,
    sessionIds: readonly string[],
    activeSessionId: string | null
  ): void {
    this.clock += 1
    if (sessionIds.length === 0) {
      const lists = this.lists.get(person)
      lists?.delete(worktreeId)
      if (lists?.size === 0) {
        this.lists.delete(person)
      }
    } else {
      this.set(person, worktreeId, { sessionIds, activeSessionId, version: this.clock })
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
