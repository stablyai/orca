// The writes to a teammate's own list in their Home (teammate-rules.ts, rule 4): a chat tab opened,
// activated, closed or retitled there lands in their list and reaches only their devices.
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  isTeammateTabList,
  tabOwnerOf,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { getActiveTeammate } from '../../rpc/callers/active-call'
import { resolveChatTabActivation } from '../chat/agent-session-tab-identity'
import type { StructuredSessionTabPublicationInput } from '../chat/structured-session-tab-publication'
import { personChatTabId } from './person-session-tab-lists'
import { OrcaRuntimeWithPersonSessionTabs, type OwnList } from './person-session-tab-publication'

export abstract class OrcaRuntimeWithPersonSessionTabWrites extends OrcaRuntimeWithPersonSessionTabs {
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

  /** The chat tab write (reveal, create, Fork, publish) for the active RPC caller's list: true when it
   *  was a teammate's own list, which then holds the tab; false leaves it to the host's list. */
  protected async publishCallerPersonChatTab(
    input: StructuredSessionTabPublicationInput
  ): Promise<boolean> {
    const teammate = getActiveTeammate()
    const owner = teammate
      ? tabOwnerOf(input.workspaceId, teammate, this.store?.getBots?.() ?? [])
      : 'shared'
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
    const tab = frame.tabs.find((candidate) => candidate.id === resolved)
    if (!tab || tab.type !== 'agent-session' || !opts.clientNavigationId) {
      throw new Error('tab_not_found')
    }
    opts.beforeActivate?.({ sessionId: tab.sessionId, worktreeId })
    const projected = this.clientSessionTabSelections.activate(
      frame,
      opts.clientNavigationId,
      tab.id
    )
    this.emitMobileSessionTabsSnapshotToClient(projected, opts.clientNavigationId)
    return projected
  }

  /** The active teammate's own list in a chat's workspace; null when the call writes the host's. */
  protected activeTeammateListOfChat(sessionId: string): OwnList | null {
    const teammate = getActiveTeammate()
    const worktreeId =
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.location.workspaceId
    const owner =
      teammate && worktreeId
        ? tabOwnerOf(worktreeId, teammate, this.store?.getBots?.() ?? [])
        : null
    return owner && worktreeId && isTeammateTabList(owner) ? { person: owner, worktreeId } : null
  }

  /** A teammate's close of a chat in their own Home closes their tab only; the host's list and
   *  window keep theirs. False leaves the close to the host's list. */
  closeActiveTeammateChatTab(sessionId: string): boolean {
    const own = this.activeTeammateListOfChat(sessionId)
    if (own) {
      this.closePersonSessionTab(own.person, own.worktreeId, personChatTabId(sessionId))
    }
    return own !== null
  }

  /** Closes a tab of a teammate's own list, if it is there. The chat keeps running, as a closed tab's
   *  chat does. */
  protected closePersonSessionTab(
    person: TeammateTabListKey,
    worktreeId: string,
    tabId: string
  ): void {
    if (!this.personSessionTabs.close(person, worktreeId, tabId)) {
      return
    }
    this.clientSessionTabSelections.forgetTabs(worktreeId, [tabId], person)
    this.clientSessionTabSelections.settleClosedTabs(
      this.personSessionTabsFrame(person, worktreeId, false),
      person
    )
    this.publishPersonSessionTabs(person, worktreeId)
  }
}
