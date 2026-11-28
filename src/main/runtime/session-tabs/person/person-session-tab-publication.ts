// Whose tab list a client reads and writes (teammate-rules.ts, rule 4): the routing, the guards on the
// host's list and window, the reads of a teammate's own list, and its lifetime (that of their share).
// The writes are in person-session-tab-writes.ts.
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { PersistedMobileClientTabSelections } from '../../../../shared/orca-profiles/persisted-state-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { BotShareDevices } from '../../../bots/team-share/bot-share-access'
import {
  isTeammateTabList,
  tabListTeammate,
  tabOwnerOf,
  teammateTabListKey,
  viewedTabListOf,
  type TabListPerson,
  type TabOwner,
  type TabTeammate,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import { BOT_HOME_NAME, ownerHomeName, type BotHomeOf } from '../../../../shared/bots/bot-home-of'
import { hostOwnerName } from '../../../bots/team-share/bot-share-scoped-view'
import { botHomeSessionId } from '../chat/bot-home-snapshot'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  sessionTabListName,
  type SessionTabListName
} from '../../client/navigation/client-session-tab-selection'
import { OrcaRuntimeWithRuntimeId } from '../../construction/runtime-identity-state'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import { PersonSessionTabLists } from './person-session-tab-lists'
import { tabListOfPty, windowOwns } from './person-workspace-target'
import { HeldTerminalStamps, heldPageOf } from './teammate-workspace-surfaces'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import type { PersonSurface } from './person-tab-list-snapshot'
import { personSurfaceRow } from './person-surface-rows'
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
  /** A teammate's own workspace as their devices read it: their Home (`toWireTabList`), projected
   *  for `projectFor`'s picks first when given. */
  protected abstract teammateWorkspaceFrame(
    list: string,
    includeAgentSenders?: boolean,
    projectFor?: { clientNavigationId: string | undefined }
  ): RuntimeMobileSessionTabsResult
  abstract listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string,
    options?: { includeInitialSurfaceLaunch?: true; includeAgentSenders?: boolean }
  ): Promise<RuntimeMobileSessionTabsResult>

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
    getRuntimeBrowserPageRegistry(this).setHolderLookup((pageId) =>
      heldPageOf(this.heldTerminals, this.store, pageId)
    )
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
    return this.mobileSessionTabsByWorktree.deliverySource(
      list === 'host' ? worktreeId : tabListOfPty({ worktreeId, holder: list })
    )
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
      (_worktree, surface) =>
        surface.kind === 'browser'
          ? this.clientBrowserPageRow(worktreeId, surface.browserPageId)
          : personSurfaceRow(worktreeId, surface, (ptyId) => this.ptysById.get(ptyId))
    )
    const result = this.titledSessionTabsResult(snapshot, undefined, {
      accountId: tabListTeammate(person).accountId
    })
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  /** The stamp a terminal's record takes when it is made: the teammate whose list holds its PTY (bound
   *  as it registers, or saved before a restart). */
  protected terminalHolderStamp(ptyId: string): { holder?: TeammateTabListKey } {
    const saved = this.store?.getWorkspaceSession?.(TEAMMATE_HOMES_SESSION_PARTITION)
    const holder = this.heldTerminals.stampOf(ptyId, this.mobileSessionTabsByWorktree, saved)
    return holder ? { holder } : {}
  }

  protected readonly heldTerminals = new HeldTerminalStamps()

  /** Chat tabs titled for the list's person, and their Home pinned: the host's list (the owner's), or
   *  a teammate's own (theirs; no saved tabs). */
  protected titledSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    savedTabs: SavedTabs = () => undefined,
    of: BotHomeOf = 'owner'
  ): RuntimeMobileSessionTabsResult {
    const namer = structuredConversationTabNamer(snapshot.worktree, savedTabs)
    // On a teammate's list the owner's Home goes by the owner's name, unless renamed.
    const ownersHome = of === 'owner' ? null : botHomeSessionId(this.store, snapshot.worktree)
    const named = (sessionId: string): string | null => {
      const name = namer(sessionId)
      return sessionId === ownersHome && name === BOT_HOME_NAME
        ? ownerHomeName(hostOwnerName())
        : name
    }
    const titled = titleStructuredConversationTabs(snapshot, named, structuredConversationForked)
    return projectTabsWithBotHomePins(this.store, titled, this.getMobileSessionProjectionHost(), of)
  }

  /** A teammate's own list in this workspace, projected for the client's picks when `project`; null
   *  when the client reads the host's. */
  protected ownSessionTabListFrame(
    worktreeId: string,
    clientNavigationId: string | undefined,
    includeAgentSenders?: boolean,
    project = false
  ): RuntimeMobileSessionTabsResult | null {
    const owner = this.tabOwnerOfClient(clientNavigationId, worktreeId)
    return isTeammateTabList(owner)
      ? this.teammateWorkspaceFrame(
          tabListOfPty({ worktreeId, holder: owner }),
          includeAgentSenders,
          project ? { clientNavigationId } : undefined
        )
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
    // No one reads a teammate's own workspace as it is; theirs stands in for the owner's Home.
    return [
      ...frames
        .filter(
          (frame) =>
            windowOwns(frame.worktree) && !own.some((list) => list.worktreeId === frame.worktree)
        )
        .map((frame) => this.projectMobileSessionTabsForClient(frame, clientNavigationId)),
      ...own.map((list) =>
        this.teammateWorkspaceFrame(
          tabListOfPty({ worktreeId: list.worktreeId, holder: list.person }),
          includeAgentSenders,
          { clientNavigationId }
        )
      )
    ]
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

  /** The list a read of `person`'s tabs names (`viewedTabListOf`), as it is: no device's pick laid
   *  over it, so a watcher reads no one's focus and changes nothing by reading. */
  async listViewedSessionTabs(
    worktreeSelector: string,
    person: TabListPerson,
    options?: { includeAgentSenders?: boolean }
  ): Promise<{ list: SessionTabListName; frame: RuntimeMobileSessionTabsResult }> {
    const worktreeId =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const list = viewedTabListOf(worktreeId, person, this.store?.getBots?.() ?? [])
    if (list === null) {
      throw new Error('unknown_tab_list_person')
    }
    return {
      list,
      frame: isTeammateTabList(list)
        ? this.personSessionTabsFrame(list, worktreeId, options?.includeAgentSenders)
        : await this.listMobileSessionTabs(worktreeSelector, undefined, options)
    }
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
  protected abstract schedulePersonListRedraw(person: TeammateTabListKey, worktreeId: string): void

  /** The workspace is gone: each person's list there, and their devices' picks in it, go too. */
  protected forgetPersonTabListsIn(worktreeId: string): void {
    for (const person of this.personSessionTabs.peopleIn(worktreeId)) {
      this.clientSessionTabSelections.forgetWorktree(worktreeId, person)
    }
    this.personSessionTabs.forgetWorktree(worktreeId)
  }
}
