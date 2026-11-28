// The writes to a person's own list in an agent's Home (teammate-rules.ts, rule 4). Every write names
// its person (`TabPerson`): a user action the caller's, a system write the chat's stamp
// (`chatTabPerson`). A teammate person's chat tab lands in their own workspace (`PersonChatTabs`);
// an owner person's goes to the host's list.
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  homeTabListOf,
  isTeammateTabList,
  teammateTabListKey,
  type TabListRef,
  type TabPerson,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { botHomeOfChat } from '../../../bots/bot-conversation-acts-for'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { resolveChatTabActivation } from '../chat/agent-session-tab-identity'
import type {
  StructuredSessionRawPublicationInput,
  StructuredSessionTabPublicationInput
} from '../chat/structured-session-tab-publication'
import type { ChatTabChange } from '../chat/agent-session-tab-layout'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import { PersonChatTabs } from './person-chat-tabs'
import { randomUUID } from 'node:crypto'
import type { RuntimeEdgeCommandSurface } from '../../construction/runtime-edge-command-controller'
import { personTabId, type PersonSurface } from './person-tab-list-snapshot'
import { createMobileSessionTabsNotifyCoalescer } from '../../session-lifecycle/publication/mobile-session-tabs-notify-coalescer'
import { isSafeMobileRelativePath } from '../../files/mobile-file-kind'
import { joinWorktreeRelativePath } from '../../files/paths/runtime-relative-paths'
import { OrcaRuntimeWithPersonSessionTabs, type OwnList } from './person-session-tab-publication'

/** A chat tab write: the publication, and the person it is for. */
export type PersonChatTabPublication = StructuredSessionTabPublicationInput & { person: TabPerson }

export abstract class OrcaRuntimeWithPersonSessionTabWrites extends OrcaRuntimeWithPersonSessionTabs {
  abstract listAutomationRuns(): AutomationRun[]
  abstract showAutomation(id: string): Automation
  abstract restoreStructuredAgentSessionTabs(): Promise<void>
  abstract notifyMobileSessionTabsChanged(worktreeId?: string): void
  protected abstract persistClientHostedBrowserPagesForWorktree(worktreeId: string): void

  protected abstract projectStructuredAgentSessionTab(
    input: StructuredSessionRawPublicationInput
  ): void
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[]
  ): Promise<void>
  protected abstract emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void

  declare readonly browserTabCreate: RuntimeEdgeCommandSurface['browserTabCreate']
  declare readonly browserTabClose: RuntimeEdgeCommandSurface['browserTabClose']

  protected readonly personChatTabs = new PersonChatTabs({
    snapshots: () => this.mobileSessionTabsByWorktree,
    storeSnapshot: (list, snapshot) => this.storeMobileSessionSnapshot(list, snapshot),
    emit: (snapshot) => this.emitMobileSessionTabsSnapshot(snapshot),
    savedLists: () => this.store?.getWorkspaceSession?.(TEAMMATE_HOMES_SESSION_PARTITION),
    saveChanges: (list, changes) => this.changeWindowlessChatTabs(list, changes),
    project: (input) => this.projectStructuredAgentSessionTab(input),
    forgetTabs: (list, tabIds) => this.clientSessionTabSelections.forgetTabs(list, tabIds),
    restoring: () =>
      void this.restoreStructuredAgentSessionTabs().catch((error: unknown) =>
        console.warn('[session-tabs] restoring chat tabs failed:', error)
      ),
    agents: () => this.store?.getBots?.() ?? [],
    closeListTab: (person, home, tabId) => this.closePersonSessionTab(person, home, tabId)
  })

  /** A browser tab create, for the person who opens it: a teammate's in their agent's Home is stamped
   *  into their own list before its page exists, so no host list ever shows it. */
  async createSessionBrowserTab(
    params: Parameters<RuntimeEdgeCommandSurface['browserTabCreate']>[0],
    caller: Parameters<RuntimeEdgeCommandSurface['browserTabCreate']>[1],
    { person }: { person: TabPerson }
  ): Promise<{ browserPageId: string }> {
    const worktreeId =
      person === 'owner' || !params.worktree
        ? null
        : (this.getExplicitSessionWorktreeIdSelector(params.worktree) ??
          (await this.resolveWorkspaceSelector(params.worktree).then(
            (workspace) => workspace.id,
            () => null
          )))
    const list = worktreeId ? this.homeTabListOf(person, worktreeId) : 'host'
    if (!worktreeId || !isTeammateTabList(list)) {
      return this.browserTabCreate(params, caller)
    }
    const surface = { kind: 'browser' as const, browserPageId: params.page ?? randomUUID() }
    const activate = params.activate !== false
    // Held before its page is published, so the page's record takes the stamp (`holder`).
    this.personSessionTabs.openSurface(list, worktreeId, surface, activate)
    try {
      const created = await this.browserTabCreate(
        { ...params, page: surface.browserPageId },
        caller
      )
      this.showPersonSurface(list, worktreeId, surface, {
        activate,
        clientNavigationId: caller?.pairedDeviceId
      })
      return created
    } catch (error) {
      this.dropPersonTab(list, worktreeId, personTabId(surface))
      throw error
    }
  }

  /** A teammate opens a file in their agent's Home: a tab of their own list, read from disk wherever
   *  it shows, so it is the same file for everyone; unsaved edits stay on the computer making them. */
  async openPersonFile(
    worktreeSelector: string,
    file: { relativePath: string; mode: 'edit' | 'diff'; staged?: boolean; oldPath?: string },
    caller: { person: TabPerson; clientNavigationId?: string; activate?: boolean }
  ): Promise<RuntimeMobileSessionTabsResult> {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    const list = this.homeTabListOf(caller.person, worktree.id)
    if (!isTeammateTabList(list)) {
      // Everyone else opens files in the host's window (`files.open`).
      throw new Error('file_tab_needs_own_list')
    }
    for (const path of [file.relativePath, file.oldPath]) {
      if (path !== undefined && !isSafeMobileRelativePath(path)) {
        throw new Error('invalid_relative_path')
      }
    }
    const surface: PersonSurface = {
      kind: 'file',
      relativePath: file.relativePath,
      filePath: joinWorktreeRelativePath(worktree.path, file.relativePath),
      mode: file.mode,
      ...(file.mode === 'diff' ? { diffSource: file.staged ? 'staged' : 'unstaged' } : {}),
      ...(file.mode === 'diff' && file.oldPath ? { oldPath: file.oldPath } : {})
    }
    const activate = caller.activate !== false
    this.personSessionTabs.openSurface(list, worktree.id, surface, activate)
    return this.showPersonSurface(list, worktree.id, surface, {
      activate,
      clientNavigationId: caller.clientNavigationId
    })
  }

  /** A tab a teammate just opened in their list: their devices redraw, and the device that opened it
   *  shows it, as a chat they open does. Nothing reaches the host's window or anyone else's screen. */
  protected showPersonSurface(
    person: TeammateTabListKey,
    worktreeId: string,
    surface: PersonSurface,
    opts: { activate: boolean; clientNavigationId?: string }
  ): RuntimeMobileSessionTabsResult {
    const shown =
      opts.activate && opts.clientNavigationId
        ? this.activatePersonSessionTab(person, worktreeId, personTabId(surface), {
            clientNavigationId: opts.clientNavigationId
          })
        : this.personSessionTabsFrame(person, worktreeId, false)
    this.publishPersonSessionTabs(person, worktreeId)
    return shown
  }

  /** The chat's stamp: whom it was created for. A chat in an agent's Home that acts for one of its
   *  teammates alone is theirs (their Home Chat, a New chat they started); every other chat is the
   *  owner's. Read from the acts-for record, written once when the chat starts. */
  chatTabPerson(sessionId: string): TabPerson {
    const workspaceId =
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.location.workspaceId
    const bot = this.store
      ?.getBots?.()
      .find((entry) => folderWorkspaceKey(entry.folderWorkspaceId) === workspaceId)
    const of = bot ? botHomeOfChat(this, bot, sessionId) : 'owner'
    return of === 'owner'
      ? 'owner'
      : teammateTabListKey({ botId: bot!.id, accountId: of.accountId })
  }

  /** The list a person's write lands in, in this workspace. */
  protected homeTabListOf(person: TabPerson, worktreeId: string): 'host' | TeammateTabListKey {
    return homeTabListOf(person, worktreeId, this.store?.getBots?.() ?? [])
  }

  /** A teammate's own list changed: every device of theirs listening redraws it. */
  protected publishPersonSessionTabs(person: TeammateTabListKey, worktreeId: string): void {
    void this.createMobileSessionTabsDelivery(person)(
      this.personSessionTabsFrame(person, worktreeId),
      ++this.mobileSessionTabsChangeSequence
    )
  }

  private readonly personListsToRedraw = new Map<string, OwnList>()
  private readonly personListRedraws = createMobileSessionTabsNotifyCoalescer((key) => {
    const list = this.personListsToRedraw.get(key)
    this.personListsToRedraw.delete(key)
    if (list) {
      this.personSessionTabs.touch(list.person, list.worktreeId)
      this.publishPersonSessionTabs(list.person, list.worktreeId)
    }
  })

  /** A teammate's terminal or page reads differently (a title, an address): their list redraws at a
   *  new version, coalesced as the host's do; no other list wakes. */
  protected schedulePersonListRedraw(person: TeammateTabListKey, worktreeId: string): void {
    const key = `${person}\0${worktreeId}`
    this.personListsToRedraw.set(key, { person, worktreeId })
    this.personListRedraws.schedule(key)
  }

  /** The one way a browser page's change is announced, from every page write and client-page path:
   *  only the list that holds the page hears. A teammate's page redraws and saves their own list (so
   *  it survives a restart); a host page notifies the host's list, which saves it. */
  notifyBrowserPageList(page: TabListRef): void {
    if (!page.holder) {
      this.notifyMobileSessionTabsChanged(page.workspaceId)
      return
    }
    this.persistClientHostedBrowserPagesForWorktree(page.workspaceId)
    this.schedulePersonListRedraw(page.holder, page.workspaceId)
  }

  /** The chat tab write (reveal, create, Fork, publish) for the person it names: true when that is a
   *  teammate's own workspace, which then holds the tab; false leaves it to the host's list. */
  protected publishPersonChatTab(input: PersonChatTabPublication): boolean {
    const list = this.personChatTabs.listOf(input.person, input.workspaceId)
    if (!list) {
      return false
    }
    input.workspaceAuthority?.check()
    const saving = this.personChatTabs.open(list, {
      sessionId: input.sessionId,
      agent: input.agent,
      activate: input.activate,
      ...(input.notify === false ? { notify: false } : {}),
      ...(input.placement ? { placement: input.placement } : {})
    })
    input.workspaceAuthority?.saving(saving)
    input.workspaceAuthority?.committed()
    input.capture?.({
      tableId: null,
      personList: list,
      presentation: {
        raw: this.currentLocalStructuredSessionPresentation(input.sessionId),
        saved: []
      }
    })
    return true
  }

  /** The teammate's own workspace a person's chat tab in `worktreeId` lands in; null for the host's. */
  teammateChatList(person: TabPerson, worktreeId: string): string | null {
    return this.personChatTabs.listOf(person, worktreeId)
  }

  /** Activates a tab of a teammate's own list on the caller's device alone: it never reaches the
   *  host's window or anyone else's screen. */
  protected activatePersonSessionTab(
    person: TeammateTabListKey,
    worktreeId: string,
    tabId: string,
    opts: {
      clientNavigationId?: string
      beforeActivate?: (target: { sessionId?: string; worktreeId: string }) => void
    }
  ): RuntimeMobileSessionTabsResult {
    const frame = this.personSessionTabsFrame(person, worktreeId, false)
    const resolved = resolveChatTabActivation(frame.tabs, tabId)
    const tab = frame.tabs.find(
      (candidate) =>
        candidate.id === resolved ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId)
    )
    if (!tab || !opts.clientNavigationId) {
      throw new Error('tab_not_found')
    }
    opts.beforeActivate?.({
      ...(tab.type === 'agent-session' ? { sessionId: tab.sessionId } : {}),
      worktreeId
    })
    const projected = this.clientSessionTabSelections.activate(
      frame,
      opts.clientNavigationId,
      tab.id
    )
    this.emitMobileSessionTabsSnapshotToClient(projected, opts.clientNavigationId)
    return projected
  }

  /** Every person a gone chat's tab must close for: the owner, and each teammate holding it. */
  chatTabPeople(sessionId: string): TabPerson[] {
    return this.personChatTabs.people(sessionId)
  }

  /** Closes a chat's tab for each person, once per list: a teammate's in their own Home closes their
   *  own tab only. `hostList` says whether one of them is the host's list, which the caller closes. */
  closeChatTabs(input: {
    people: readonly TabPerson[]
    sessionId: string
  }): Promise<{ hostList: boolean }> {
    return this.personChatTabs.closeFor(input.people, input.sessionId)
  }

  /** Closes a tab of a teammate's own list, if it is there. A chat keeps running, as a closed tab's
   *  chat does; a terminal or page they opened ends with its tab, as the host's own do. */
  protected closePersonSessionTab(
    person: TeammateTabListKey,
    worktreeId: string,
    tabId: string
  ): void {
    const closed = this.dropPersonTab(person, worktreeId, tabId)
    if (closed && closed.kind !== 'chat') {
      this.endPersonSurface(worktreeId, closed)
    }
  }

  /** A teammate's terminal exited or their page retired: its tab leaves their list. */
  protected forgetPersonSurface(matches: (surface: PersonSurface) => boolean): void {
    const held = this.personSessionTabs.holderOfSurface(matches)
    if (held) {
      this.dropPersonTab(held.person, held.worktreeId, held.tabId)
    }
  }

  /** A file tab holds nothing on the host; a terminal stops, a page closes. */
  protected endPersonSurface(worktreeId: string, surface: PersonSurface): void {
    if (surface.kind === 'terminal' && surface.ptyId) {
      this.ptyController?.kill(surface.ptyId)
    } else if (surface.kind === 'browser') {
      void this.browserTabClose({
        worktree: `id:${worktreeId}`,
        page: surface.browserPageId
      }).catch((error: unknown) =>
        console.warn('[session-tabs] closing a teammate’s page failed:', error)
      )
    }
  }

  protected dropPersonTab(person: TeammateTabListKey, worktreeId: string, tabId: string) {
    const closed = this.personSessionTabs.close(person, worktreeId, tabId)
    if (!closed) {
      return null
    }
    const closedId = personTabId(closed)
    this.clientSessionTabSelections.forgetTabs(worktreeId, [closedId], person)
    this.clientSessionTabSelections.settleClosedTabs(
      this.personSessionTabsFrame(person, worktreeId, false),
      person
    )
    this.publishPersonSessionTabs(person, worktreeId)
    return closed
  }
}
