// Whose tab list a client reads and writes (teammate-rules.ts, rule 4): the routing, the guards on the
// host's list and window, the reads of a teammate's own list, and its lifetime (that of their share).
// The writes are in person-session-tab-writes.ts.
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { normalizeMobileSessionTabSelection } from '../layout/mobile-session-tab-selection'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
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
import {
  sessionTabListName,
  type SessionTabListName
} from '../../client/navigation/client-session-tab-selection'
import { OrcaRuntimeWithRuntimeId } from '../../construction/runtime-identity-state'
import { PersonSessionTabLists } from './person-session-tab-lists'
import type { PersonSurface, PersonSurfaceRow } from './person-tab-list-snapshot'
import { buildMaterializedHeadlessParentLayout } from '../../terminal/surface/mobile-session-layout-projection'

type PersonSurfaceRowTab = NonNullable<ReturnType<PersonSurfaceRow>>
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

export type OwnList = { person: TeammateTabListKey; worktreeId: string }

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
  /** A client-hosted page's row, when the page is in this workspace. */
  protected abstract clientBrowserPageRow(
    worktreeId: string,
    browserPageId: string
  ): RuntimeMobileSessionBrowserTab | null
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
      this.pruneTeammateTabLists()
    }
    const bots = () => this.store?.getBots?.() ?? []
    this.clientSessionTabSelections.setPersistListener(() => this.persistSessionTabLists())
    // Until the share devices load, a device in an agent's Home may be a teammate's: left alone.
    this.clientSessionTabSelections.setTabOwnerResolver((client, worktreeId) =>
      this.botShareDevices || tabOwnerOf(worktreeId, null, bots()) === 'shared'
        ? this.tabOwnerOfClient(client, worktreeId)
        : null
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
    const snapshot = this.personSessionTabs.snapshot(
      person,
      worktreeId,
      (_worktree, sessionId) => {
        const record = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
        return record?.location.workspaceId === worktreeId
          ? { agent: record.provider, title: defaultAgentChatLabel(record.provider) }
          : null
      },
      (_worktree, surface) => this.personSurfaceRow(worktreeId, surface)
    )
    const result = this.titledSessionTabsResult(snapshot)
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  /** Rule 4: the host's list never shows a terminal or page a teammate opened in their Home. Every
   *  write of the host's list passes here (`storeMobileSessionSnapshot`), whichever projection made it. */
  protected withoutPersonSurfaces(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const held = this.personSessionTabs.surfacesIn(snapshot.worktree)
    const hidden = (tab: RuntimeMobileSessionSnapshotTab) =>
      held.some((surface) =>
        surface.kind === 'browser'
          ? tab.type === 'browser' && tab.browserPageId === surface.browserPageId
          : tab.type === 'terminal' &&
            (tab.parentTabId === surface.parentTabId ||
              (surface.ptyId !== null && tab.ptyId === surface.ptyId))
      )
    const gone = held.length > 0 ? snapshot.tabs.filter(hidden) : []
    if (gone.length === 0) {
      return snapshot
    }
    const goneIds = new Set(
      gone.flatMap((tab) =>
        tab.type === 'terminal'
          ? [tab.id, tab.parentTabId]
          : tab.type === 'browser'
            ? [tab.id, tab.browserWorkspaceId]
            : [tab.id]
      )
    )
    return normalizeMobileSessionTabSelection({
      ...snapshot,
      tabs: snapshot.tabs.filter((tab) => !gone.includes(tab)),
      ...(snapshot.tabGroups
        ? {
            tabGroups: snapshot.tabGroups.map((group) => ({
              ...group,
              tabOrder: group.tabOrder.filter((id) => !goneIds.has(id)),
              activeTabId:
                group.activeTabId && goneIds.has(group.activeTabId) ? null : group.activeTabId
            }))
          }
        : {})
    })
  }

  /** Whether a teammate's own list holds this terminal: then no host list or window places it. */
  protected holdsPersonTerminal(ptyId: string): boolean {
    return (
      this.personSessionTabs.holderOfSurface(
        (surface) => surface.kind === 'terminal' && surface.ptyId === ptyId
      ) !== null
    )
  }

  /** A person's terminal or page as its row reads now; null while it is not running here. */
  private personSurfaceRow(worktreeId: string, surface: PersonSurface): PersonSurfaceRowTab | null {
    if (surface.kind === 'browser') {
      return this.clientBrowserPageRow(worktreeId, surface.browserPageId)
    }
    const pty = surface.ptyId ? this.terminalIdentity.ptys.get(surface.ptyId) : undefined
    if (!pty?.connected || pty.worktreeId !== worktreeId) {
      return null
    }
    return {
      type: 'terminal',
      id: `${surface.parentTabId}::${surface.leafId}`,
      title: pty.title || 'Terminal',
      parentTabId: surface.parentTabId,
      leafId: surface.leafId,
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
      parentLayout: buildMaterializedHeadlessParentLayout(surface.leafId, pty.ptyId, undefined),
      isActive: false
    }
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

  /** A person's list lives as long as their share of the agent: it goes when the share or the
   *  agent does, whichever path removed it and whether or not their devices were reached. */
  pruneTeammateTabLists(): void {
    const live = new Set(
      (this.store?.getBots?.() ?? []).flatMap((bot) =>
        (bot.shares ?? []).flatMap((share) =>
          share.kind === 'account'
            ? [teammateTabListKey({ botId: bot.id, accountId: share.accountId })]
            : []
        )
      )
    )
    const ended = this.personSessionTabs.forgetPeople((person) => !live.has(person))
    for (const { worktreeId, surface } of ended) {
      this.endPersonSurface(worktreeId, surface)
    }
  }

  /** Stops a closed terminal, closes a closed page. */
  protected abstract endPersonSurface(worktreeId: string, surface: PersonSurface): void

  /** The workspace is gone: each person's list there, and their devices' picks in it, go too. */
  protected forgetPersonTabListsIn(worktreeId: string): void {
    for (const person of this.personSessionTabs.holdersOf(worktreeId, () => true)) {
      this.clientSessionTabSelections.forgetWorktree(worktreeId, person)
    }
    this.personSessionTabs.forgetWorktree(worktreeId)
  }
}
