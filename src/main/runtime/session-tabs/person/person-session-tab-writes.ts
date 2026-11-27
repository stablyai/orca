// The writes to a person's own list in an agent's Home (teammate-rules.ts, rule 4). Every write names
// its person (`TabPerson`): a user action the caller's, a system write the chat's stamp
// (`chatTabPerson`). A teammate person's chat tab, opened, activated, closed or retitled there,
// lands in their list and reaches only their devices; an owner person's goes to the host's list.
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  homeTabListOf,
  isTeammateTabList,
  teammateTabListKey,
  type TabPerson,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { botHomeOfChat } from '../../../bots/bot-conversation-acts-for'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { resolveChatTabActivation } from '../chat/agent-session-tab-identity'
import type { StructuredSessionTabPublicationInput } from '../chat/structured-session-tab-publication'
import { randomUUID } from 'node:crypto'
import type { RuntimeEdgeCommandSurface } from '../../construction/runtime-edge-command-controller'
import { personChatTabId, personTabId, type PersonSurface } from './person-tab-list-snapshot'
import { OrcaRuntimeWithPersonSessionTabs } from './person-session-tab-publication'

/** A chat tab write: the publication, and the person it is for. */
export type PersonChatTabPublication = StructuredSessionTabPublicationInput & { person: TabPerson }

export abstract class OrcaRuntimeWithPersonSessionTabWrites extends OrcaRuntimeWithPersonSessionTabs {
  abstract listAutomationRuns(): AutomationRun[]
  abstract showAutomation(id: string): Automation

  declare readonly browserTabCreate: RuntimeEdgeCommandSurface['browserTabCreate']
  declare readonly browserTabClose: RuntimeEdgeCommandSurface['browserTabClose']

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
    const browserPageId = params.page ?? randomUUID()
    const matches = (surface: PersonSurface) =>
      surface.kind === 'browser' && surface.browserPageId === browserPageId
    this.personSessionTabs.openSurface(
      list,
      worktreeId,
      { kind: 'browser', browserPageId },
      params.activate !== false
    )
    try {
      const created = await this.browserTabCreate({ ...params, page: browserPageId }, caller)
      this.publishPersonSessionTabs(list, worktreeId)
      return created
    } catch (error) {
      this.forgetPersonSurface(matches)
      throw error
    }
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

  /** A chat was renamed: the lists holding it or a fork of it redraw at a new version, titled as
   *  they are read. */
  protected republishPersonListsHolding(worktreeId: string, sessionId: string): void {
    const store = getStructuredAgentSessionHost()?.deps.store
    const people = this.personSessionTabs.holdersOf(
      worktreeId,
      (held) =>
        held === sessionId || store?.getConversation(held)?.forkedFrom?.sessionId === sessionId
    )
    for (const person of people) {
      this.personSessionTabs.touch(person, worktreeId)
      this.publishPersonSessionTabs(person, worktreeId)
    }
  }

  /** A workspace's terminals or pages changed (a title, a page's address): each teammate list holding
   *  one of them there redraws at a new version. */
  protected republishPersonSurfaceLists(worktreeId: string): void {
    for (const person of this.personSessionTabs.surfaceHoldersIn(worktreeId)) {
      this.personSessionTabs.touch(person, worktreeId)
      this.publishPersonSessionTabs(person, worktreeId)
    }
  }

  /** The chat tab write (reveal, create, Fork, publish) for the person it names: true when that is a
   *  teammate's own list, which then holds the tab; false leaves it to the host's list. */
  protected async publishPersonChatTab(input: PersonChatTabPublication): Promise<boolean> {
    const owner = this.homeTabListOf(input.person, input.workspaceId)
    if (!isTeammateTabList(owner)) {
      return false
    }
    const host = getStructuredAgentSessionHost()
    // A create founds a host tab row for its new chat; a chat the host's list shows keeps its tab.
    const hostListed = this.mobileSessionTabsByWorktree
      .get(input.workspaceId)
      ?.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === input.sessionId)
    if (host?.getSessionTabId(input.sessionId) && !hostListed) {
      await host.setSessionTabVisibility(input.sessionId, false, undefined, { background: true })
    }
    input.workspaceAuthority?.check()
    this.personSessionTabs.open(owner, input.workspaceId, input.sessionId, input.activate)
    // Opened again: no device of theirs keeps it hidden as closed.
    this.clientSessionTabSelections.reopenForAllClients(
      input.workspaceId,
      personChatTabId(input.sessionId),
      owner
    )
    input.workspaceAuthority?.committed()
    input.capture?.({
      tableId: null,
      personList: true,
      presentation: {
        raw: this.currentLocalStructuredSessionPresentation(input.sessionId),
        saved: []
      }
    })
    if (input.notify !== false) {
      this.publishPersonSessionTabs(owner, input.workspaceId)
    }
    return true
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

  /** Every person a gone chat's tab must close for: the owner (the host's list), and each teammate
   *  whose own list holds it. */
  chatTabPeople(sessionId: string): TabPerson[] {
    const worktreeId =
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.location.workspaceId
    const holders = worktreeId
      ? this.personSessionTabs.holdersOf(worktreeId, (held) => held === sessionId)
      : []
    return ['owner', ...holders]
  }

  /** Closes a chat's tab for each person, once per list: a teammate's in their own Home closes their
   *  own tab only. `hostList` says whether one of them is the host's list, which the caller closes. */
  closeChatTabs(input: { people: readonly TabPerson[]; sessionId: string }): { hostList: boolean } {
    const worktreeId = getStructuredAgentSessionHost()?.deps.store.getConversation(input.sessionId)
      ?.location.workspaceId
    let hostList = false
    for (const person of input.people) {
      const list = worktreeId ? this.homeTabListOf(person, worktreeId) : 'host'
      if (worktreeId && isTeammateTabList(list)) {
        this.closePersonSessionTab(list, worktreeId, personChatTabId(input.sessionId))
      } else {
        hostList = true
      }
    }
    return { hostList }
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

  protected endPersonSurface(worktreeId: string, surface: PersonSurface): void {
    if (surface.kind === 'terminal') {
      if (surface.ptyId) {
        this.ptyController?.kill(surface.ptyId)
      }
      return
    }
    void this.browserTabClose({ worktree: `id:${worktreeId}`, page: surface.browserPageId }).catch(
      (error: unknown) => console.warn('[session-tabs] closing a teammate’s page failed:', error)
    )
  }

  private dropPersonTab(person: TeammateTabListKey, worktreeId: string, tabId: string) {
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
