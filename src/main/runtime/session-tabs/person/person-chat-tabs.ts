// The one owner of a chat tab in a teammate's own workspace (`person:`) in a shared agent's Home:
// open, close, rename and restore. A row there lives in that workspace's snapshot and saved session
// only; it never reads or writes the owner's chat tabs or the chat's host tab row. Ordered as the
// owner's are: each write changes the live row synchronously and issues its save through the one
// ordered layout save, so call order is the order everywhere.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  homeOfPersonWorkspace,
  isPersonWorkspaceKey,
  parsePersonWorkspaceKey,
  type PersonWorkspaceKey
} from '../../../../shared/workspace/identity/person-workspace-key'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { ChatTabChange } from '../chat/agent-session-tab-layout'
import type { StructuredSessionRawPublicationInput } from '../chat/structured-session-tab-publication'
import { retireStructuredAgentSessionTabFrom } from '../chat/structured-agent-session-tab-retirement'
import { personChatTabId } from './person-tab-list-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import {
  teammateTabListKey,
  type TabPerson,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import { findAddressedSessionTab } from '../layout/addressed-session-tab'
import { personTabListOf } from './person-workspace-target'
import {
  committedMobileSessionTabClose,
  refusedMobileSessionTabClose,
  type MobileSessionTabCloseOutcome
} from '../../session-lifecycle/close/mobile-session-tab-close-outcome'

export type PersonChatTabsHost = {
  snapshots(): ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  storeSnapshot(
    list: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  emit(snapshot: RuntimeMobileSessionTabsSnapshot): void
  /** The teammates' saved partition, whose `unifiedTabs` are keyed by person workspace. */
  savedLists(): WorkspaceSessionState | undefined
  saveChanges(list: string, changes: readonly ChatTabChange[]): Promise<void>
  project(input: StructuredSessionRawPublicationInput): void
  forgetTabs(list: string, tabIds: readonly string[]): void
  /** Starts the host's chat tab restore, as any chat tab write does; nothing here waits for it. */
  restoring(): void
  agents(): readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
  /** A teammate's non-chat tab close, in their person list. */
  closeListTab(person: TeammateTabListKey, home: string, tabId: string): void
}

export type PersonChatOpen = {
  sessionId: string
  agent: StructuredAgentId
  activate: boolean
  notify?: boolean
  placement?: { groupId?: string; afterTabId?: string }
}

export class PersonChatTabs {
  constructor(private readonly host: PersonChatTabsHost) {}

  /** The lists whose saved chat rows are live this run. */
  private readonly hydrated = new Set<string>()

  /** Before a list's first write this run: its saved chat rows, as they were placed, go live. */
  private hydrate(list: string): void {
    if (this.hydrated.has(list)) {
      return
    }
    this.hydrated.add(list)
    const sessions = getStructuredAgentSessionHost()?.deps.store
    for (const tab of this.host.savedLists()?.unifiedTabs?.[list] ?? []) {
      const agent =
        tab.contentType === 'agent-session'
          ? sessions?.getConversation(tab.entityId)?.provider
          : undefined
      if (agent) {
        this.host.project({
          workspaceId: list,
          sessionId: tab.entityId,
          agent,
          activate: false,
          notify: false,
          rowId: personChatTabId(tab.entityId)
        })
      }
    }
  }

  /** Opens the chat's row: live now, its save issued now. Resolves once the save lands. */
  open(list: PersonWorkspaceKey, chat: PersonChatOpen): Promise<void> {
    this.host.restoring()
    this.hydrate(list)
    const saved = this.host.saveChanges(list, [
      {
        open: {
          sessionId: chat.sessionId,
          agent: chat.agent,
          tabId: structuredAgentSessionTabId(chat.sessionId),
          ...(chat.placement ? { placement: chat.placement } : {})
        }
      }
    ])
    this.host.project({
      workspaceId: list,
      sessionId: chat.sessionId,
      agent: chat.agent,
      activate: chat.activate,
      rowId: personChatTabId(chat.sessionId),
      ...(chat.notify === false ? { notify: false } : {}),
      ...(chat.placement ? { placement: chat.placement } : {})
    })
    return saved
  }

  /** Drops the chat's row, live now and its save issued now; the chat runs on, as a closed tab's
   *  does. Resolves once the save lands. */
  close(list: string, sessionId: string): Promise<void> {
    this.hydrate(list)
    const snapshot = this.host.snapshots().get(list)
    const next = snapshot ? retireStructuredAgentSessionTabFrom(snapshot, sessionId) : null
    if (next) {
      this.host.emit(this.host.storeSnapshot(list, next))
      this.host.forgetTabs(list, [personChatTabId(sessionId)])
    }
    const tabId = this.savedChatTabId(list, sessionId) ?? structuredAgentSessionTabId(sessionId)
    return this.host.saveChanges(list, [{ close: sessionId, tabId }])
  }

  /** A person's own workspace in their agent's Home; null for the owner and everywhere else. */
  listOf(person: TabPerson, worktreeId: string): PersonWorkspaceKey | null {
    const list = personTabListOf(this.host.agents(), worktreeId, person)
    return isPersonWorkspaceKey(list) ? list : null
  }

  /** Every person a gone chat's tab must close for: the owner (the host's list), and each teammate
   *  whose own workspace holds it. */
  people(sessionId: string): TabPerson[] {
    const home = homeOf(sessionId)
    return [
      'owner',
      ...(home ? this.listsHolding(home, sessionId) : []).flatMap((list) => {
        const ref = parsePersonWorkspaceKey(list)
        return ref ? [teammateTabListKey(ref)] : []
      })
    ]
  }

  /** Closes the chat's tab for each person; `hostList` when one is the host's, which the caller closes. */
  async closeFor(people: readonly TabPerson[], sessionId: string): Promise<{ hostList: boolean }> {
    const home = homeOf(sessionId)
    let hostList = false
    for (const person of people) {
      const list = home ? this.listOf(person, home) : null
      if (list) {
        await this.close(list, sessionId)
      } else {
        hostList = true
      }
    }
    return { hostList }
  }

  /** A teammate's tab close in their Home: a chat in their own workspace closes here, anything
   *  else in their list. A lifecycle close names a terminal, so it refuses a chat, as the owner's. */
  async closeTeammateTab(
    person: TeammateTabListKey,
    home: string,
    tabId: string,
    close: { expectedTerminalHandle?: string }
  ): Promise<MobileSessionTabCloseOutcome> {
    const list = this.listOf(person, home)
    if (list) {
      this.hydrate(list)
    }
    const chat = list ? findAddressedSessionTab(this.host.snapshots().get(list)?.tabs, tabId) : null
    if (!list || chat?.type !== 'agent-session') {
      this.host.closeListTab(person, home, tabId)
      return committedMobileSessionTabClose(this.selections, home, [])
    }
    if (close.expectedTerminalHandle !== undefined) {
      return refusedMobileSessionTabClose('stale-terminal')
    }
    // Every chat in a shared agent's Home runs on when its tab closes, as the owner's do there.
    await this.close(list, chat.sessionId)
    return committedMobileSessionTabClose(this.selections, list, [chat.id])
  }

  private readonly selections = {
    forgetTabs: (list: string, tabIds: readonly string[]) => this.host.forgetTabs(list, tabIds)
  }

  /** Every teammate's list in `home` that holds the chat, live or saved. */
  listsHolding(home: string, sessionId: string): PersonWorkspaceKey[] {
    return this.listsOf(home).filter(
      (list) =>
        this.host
          .snapshots()
          .get(list)
          ?.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId) ||
        this.savedChatTabId(list, sessionId) !== null
    )
  }

  /** Every teammate's list in `home`, live or saved. */
  listsOf(home: string): PersonWorkspaceKey[] {
    const keys = new Set([
      ...this.host.snapshots().keys(),
      ...Object.keys(this.host.savedLists()?.unifiedTabs ?? {})
    ])
    return [...keys].filter(
      (key): key is PersonWorkspaceKey =>
        isPersonWorkspaceKey(key) && homeOfPersonWorkspace(key) === home
    )
  }

  /** After a host start: every saved teammate list goes live, as its first write would make it. */
  restore(): void {
    for (const list of Object.keys(this.host.savedLists()?.unifiedTabs ?? {})) {
      if (isPersonWorkspaceKey(list)) {
        this.hydrate(list)
      }
    }
  }

  private savedChatTabId(list: string, sessionId: string): string | null {
    return (
      this.host
        .savedLists()
        ?.unifiedTabs?.[list]?.find(
          (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
        )?.id ?? null
    )
  }
}

/** The workspace a chat runs in, by its record. */
function homeOf(sessionId: string): string | undefined {
  return getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.location
    .workspaceId
}
