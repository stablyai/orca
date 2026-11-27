// Whose tab list a client reads and writes (teammate-rules.ts, rule 4), and the operations on a
// teammate's own list in their Home: read, open, activate, close and publish. A call `tabOwnerOf` sends
// here never reads or writes the host's list (mobileSessionTabsByWorktree, the saved workspace
// session, visible agent_session_tabs).
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { PersistedMobileClientTabSelections } from '../../../../shared/orca-profiles/persisted-state-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { BotShareDevices } from '../../../bots/team-share/bot-share-access'
import {
  isTeammateTabList,
  tabOwnerOf,
  teammateTabListKey,
  type TabOwner,
  type TabTeammate,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { getActiveRpcCaller } from '../../rpc/callers/active-call'
import {
  sessionTabListName,
  type SessionTabListName
} from '../../client/navigation/client-session-tab-selection'
import { OrcaRuntimeWithRuntimeId } from '../../construction/runtime-identity-state'
import { resolveChatTabActivation } from '../chat/agent-session-tab-identity'
import type { StructuredSessionTabPublicationInput } from '../chat/structured-session-tab-publication'
import { PersonSessionTabLists } from './person-session-tab-lists'
import {
  structuredConversationForked,
  titleStructuredConversationTabs
} from '../chat/structured-conversation-tab-title'
import {
  structuredConversationTabNamer,
  type SavedTabs
} from '../chat/structured-conversation-tab-namer'
import { projectTabsWithBotHomePins } from '../../session-lifecycle/projection/bot-home-pinned-projection'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as Projection } from '../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as Publication } from '../publication/session-tabs-change-publication'

type OwnList = { person: TeammateTabListKey; worktreeId: string }

export abstract class OrcaRuntimeWithPersonSessionTabs extends OrcaRuntimeWithRuntimeId {
  /** Set by the RPC server once it starts (`OrcaRuntimeWithBots`). */
  declare botShareDevices: BotShareDevices | null

  /** Each teammate's own tab list in the agent's Home; the host's lists stay in mobileSessionTabsByWorktree. */
  protected readonly personSessionTabs = new PersonSessionTabLists(() =>
    this.persistSessionTabLists()
  )

  protected abstract createMobileSessionTabsDelivery(
    ...args: Parameters<Publication['createMobileSessionTabsDelivery']>
  ): ReturnType<Publication['createMobileSessionTabsDelivery']>
  protected abstract withMobileSessionTabSenders(
    result: RuntimeMobileSessionTabsResult
  ): RuntimeMobileSessionTabsResult
  protected abstract getMobileSessionTabsForWorktree(
    ...args: Parameters<Publication['getMobileSessionTabsForWorktree']>
  ): ReturnType<Publication['getMobileSessionTabsForWorktree']>
  protected abstract emitMobileSessionTabsSnapshotToClient(
    ...args: Parameters<Publication['emitMobileSessionTabsSnapshotToClient']>
  ): ReturnType<Publication['emitMobileSessionTabsSnapshotToClient']>
  protected abstract projectMobileSessionTabsForClient(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  protected abstract getMobileSessionProjectionHost(): ReturnType<
    Projection['getMobileSessionProjectionHost']
  >
  abstract getExplicitSessionWorktreeIdSelector(selector: string | undefined): string | null
  abstract currentLocalStructuredSessionPresentation(
    sessionId: string
  ): { worktreeId: string; tabId: string } | null

  /** Whose tab list a client reads and writes in a workspace. No client, or a client that is not a
   *  teammate's device, is the host's. */
  protected tabOwnerOfClient(clientNavigationId: string | undefined, worktreeId: string): TabOwner {
    const teammate = clientNavigationId
      ? (this.botShareDevices?.teammateOfDevice(clientNavigationId) ?? null)
      : null
    return teammate ? tabOwnerOf(worktreeId, teammate, this.store?.getBots?.() ?? []) : 'shared'
  }

  protected sessionTabListOf(
    clientNavigationId: string | undefined,
    worktreeId: string
  ): SessionTabListName {
    return sessionTabListName(this.tabOwnerOfClient(clientNavigationId, worktreeId))
  }

  /** Reads the saved lists and devices' picks, and keeps both saved in their one field. */
  protected wireSessionTabLists(persisted: PersistedMobileClientTabSelections | undefined): void {
    if (persisted) {
      this.clientSessionTabSelections.hydrate(persisted)
      this.personSessionTabs.hydrate(persisted)
    }
    this.clientSessionTabSelections.setPersistListener(() => this.persistSessionTabLists())
    this.clientSessionTabSelections.setTabOwnerResolver((client, worktreeId) =>
      this.tabOwnerOfClient(client, worktreeId)
    )
  }

  private persistSessionTabLists(): void {
    this.store?.setMobileClientTabSelections?.({
      ...this.clientSessionTabSelections.serialize(),
      ...this.personSessionTabs.serialize()
    })
  }

  protected sessionTabListDeliverySource(list: SessionTabListName, worktreeId: string): unknown {
    return list === 'host'
      ? this.mobileSessionTabsByWorktree.deliverySource(worktreeId)
      : this.personSessionTabs.deliverySource(list, worktreeId)
  }

  protected personSessionTabsFrame(
    person: TeammateTabListKey,
    worktreeId: string,
    includeAgentSenders = true
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.personSessionTabs.snapshot(person, worktreeId, (_worktree, sessionId) => {
      const record = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
      return record?.location.workspaceId === worktreeId
        ? { agent: record.provider, title: defaultAgentChatLabel(record.provider) }
        : null
    })
    const result = this.titledSessionTabsResult(snapshot)
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  /** Chat tabs titled and the agent's Home pinned: the host's list, or a teammate's own (no saved tabs). */
  protected titledSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    savedTabs: SavedTabs = () => undefined
  ): RuntimeMobileSessionTabsResult {
    const namer = structuredConversationTabNamer(snapshot.worktree, savedTabs)
    const titled = titleStructuredConversationTabs(snapshot, namer, structuredConversationForked)
    return projectTabsWithBotHomePins(this.store, titled, this.getMobileSessionProjectionHost())
  }

  /** A teammate's own list in this workspace, unprojected; null when the client reads the host's. */
  protected ownSessionTabListFrame(
    worktreeId: string,
    clientNavigationId: string | undefined,
    includeAgentSenders?: boolean
  ): RuntimeMobileSessionTabsResult | null {
    const owner = this.tabOwnerOfClient(clientNavigationId, worktreeId)
    return isTeammateTabList(owner)
      ? this.personSessionTabsFrame(owner, worktreeId, includeAgentSenders)
      : null
  }

  /** The census a client reads, projected for it: a teammate's own Home list stands in for the
   *  host's there, empty or not. */
  protected projectSessionTabsCensus(
    frames: readonly RuntimeMobileSessionTabsResult[],
    clientNavigationId: string | undefined,
    includeAgentSenders?: boolean
  ): RuntimeMobileSessionTabsResult[] {
    const own = this.ownSessionTabListsOf(clientNavigationId)
    return [
      ...frames.filter((frame) => !own.some((list) => list.worktreeId === frame.worktree)),
      ...own.map((list) =>
        this.personSessionTabsFrame(list.person, list.worktreeId, includeAgentSenders)
      )
    ].map((frame) => this.projectMobileSessionTabsForClient(frame, clientNavigationId))
  }

  private ownSessionTabListsOf(clientNavigationId: string | undefined): OwnList[] {
    const teammate = clientNavigationId
      ? this.botShareDevices?.teammateOfDevice(clientNavigationId)
      : null
    const bot = teammate && this.store?.getBots?.().find((entry) => entry.id === teammate.botId)
    return teammate && bot
      ? [
          {
            person: teammateTabListKey(teammate),
            worktreeId: folderWorkspaceKey(bot.folderWorkspaceId)
          }
        ]
      : []
  }

  /** The tab list a client reads in a workspace, before its own focus is applied. */
  protected async sessionTabListOfClient(
    worktreeId: string,
    clientNavigationId: string | undefined
  ): Promise<RuntimeMobileSessionTabsResult> {
    return (
      this.ownSessionTabListFrame(worktreeId, clientNavigationId, false) ??
      (await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
        includeAgentSenders: false
      }))
    )
  }

  /** Whether a workspace a teammate's call names is their own Home; an unknown one is not. */
  async namesTeammateHome(worktreeSelector: string, teammate: TabTeammate): Promise<boolean> {
    const worktreeId =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector).then(
        (worktree) => worktree.id,
        () => null
      ))
    return (
      worktreeId !== null &&
      isTeammateTabList(tabOwnerOf(worktreeId, teammate, this.store?.getBots?.() ?? []))
    )
  }

  /** A share ended (one teammate's, or the bot's for everyone): their lists in its Home go. */
  forgetTeammateTabLists(botId: string, accountId?: string): void {
    const bot = teammateTabListKey({ botId, accountId: '' })
    this.personSessionTabs.forgetPeople((person) =>
      accountId === undefined
        ? person.startsWith(bot)
        : person === teammateTabListKey({ botId, accountId })
    )
  }

  /** A teammate's own list changed: every device of theirs listening redraws it. */
  protected publishPersonSessionTabs(person: TeammateTabListKey, worktreeId: string): void {
    void this.createMobileSessionTabsDelivery(person)(
      this.personSessionTabsFrame(person, worktreeId),
      ++this.mobileSessionTabsChangeSequence
    )
  }

  /** A chat was renamed: the lists holding it redraw, titled as they are read. */
  protected republishPersonListsHolding(worktreeId: string, sessionId: string): void {
    for (const person of this.personSessionTabs.holdersOf(worktreeId, sessionId)) {
      this.publishPersonSessionTabs(person, worktreeId)
    }
  }

  /** The chat tab write (reveal, create, Fork, publish) for the active RPC caller's list: true when it
   *  was a teammate's own list, which then holds the tab; false leaves it to the host's list. */
  protected async publishCallerPersonChatTab(
    input: StructuredSessionTabPublicationInput
  ): Promise<boolean> {
    const caller = getActiveRpcCaller()
    const owner = this.tabOwnerOfClient(
      caller?.kind === 'paired-device' ? caller.deviceId : undefined,
      input.workspaceId
    )
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
