import type { BotSessionHooks } from '../bots/bot-turn-ended'
import { UNSET_BOT_SESSION_HOOKS } from '../bots/bot-session-hooks-unset'
import { sessionRepliesInSlack } from '../external-conversations/external-conversation-links'
import { join } from 'node:path'
import type { Worktree } from '../../shared/worktree/types'
import type { Bot } from '../../shared/bot-types'
import type { AgentStatusOrchestrationContext } from '../../shared/agent-status/contracts/agent-status-types'
import type { BotAccessRequestWatch } from '../bots/bot-access-request-watch'
import type { ConnectorGitHubInstallations } from '../connector-cloud/connector-github-installations'
import { BotChangeNotices } from '../bots/bot-change-notices'
import { deleteAutomationsOfBot } from '../bots/bot-automations-removal'
import { syncBotAutomationAgents } from '../bots/bot-automation-agent-sync'
import { BotController } from '../bots/bot-controller'
import {
  BotLookAroundStore,
  lookAroundFileIo,
  lookAroundStoreFile
} from '../bots/bot-look-around-store'
import { botsRootFolder, localBotHomeFilesystem } from '../bots/bot-home'
import { journaledItemsNotice } from '../bots/bot-memory-journal-runtime'
import { BotSharePicksStore } from '../bots/sharing/bot-share-picks-store'
import { BotShareCandidates } from '../bots/sharing/bot-package-export'
import type { BotShareClient } from '../bots/sharing/bot-share-client'
import type { BotShareDownloadPolicy } from '../bots/sharing/bot-share-receive'
import { BotShareService } from '../bots/sharing/bot-share-service'
import { readBotShareable } from '../bots/sharing/bot-share-sources'
import {
  botHomeWorktreeOnBranch,
  runtimeBotWork,
  workerGitHubRepo,
  type BotHomeLineage,
  type BotWorkRuntime
} from '../bots/bot-work-runtime'
import type { WorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { createBotLookupIndex } from '../../shared/bots/bot-lookup-index'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import type { OwnPullRequest } from '../connector-cloud/own-pr-trigger-guard'
import { botWorkHasPrBranch, botWorkRowsForRuntime } from '../bots/bot-work-pr-branch'
import { profileAccountUserId } from '../orca-profiles/profile-account-user-id'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { OrcaRuntimeWithLinearCommands } from './integrations/linear/linear-commands'
import { botStructuredSessionWiring, type WiredBot } from '../bots/bot-structured-session-wiring'
import { botChatJournal } from '../bots/bot-chat-reads'
import type { RuntimeStore } from './construction/runtime-store-contract'
import { googleSetupRuns } from '../google/google-setup-runs'
import { onBotToolSignInChanged } from '../bots/bot-tool-sign-in-changed'
import { onBotToolCredentialEnded } from '../bots/bot-tool-credential-ended'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { BotChatTreeIndex } from '../bots/bot-chat-tree-index'
import { BotChatTreeWorkerCache } from '../bots/bot-chat-tree-worker-cache'
import { pairedBotRosterCache } from '../bots/paired-bot-rosters'
import type { DispatchRowChange } from './orchestration/db/worker-status-notice'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { isStructuredAttentionMuted } from './agent-session/lifecycle/structured-agent-session-mobile-attention'
import { backfillInstalledBotBackgroundChats } from '../bots/bot-background-chat-backfill'
import { runtimeBotItems } from '../bots/bot-items-runtime'
import { botItemOfReport } from '../bots/bot-item-report-fact'

export abstract class OrcaRuntimeWithBots extends OrcaRuntimeWithLinearCommands {
  /** Set at construction (orcad: as its account installs); a profile switch publishes another
   *  active profile while this store lives on. */
  protected servedOrcaProfileId: string | null = null

  serveOrcaProfile(profileId: string): void {
    this.servedOrcaProfileId = profileId
  }
  /** The host's access-request store, once the desktop connector starts it; null on a host without one. */
  botAccessWatch: Pick<BotAccessRequestWatch, 'list' | 'answered'> | null = null
  /** The host's GitHub orgs as its connector says them; null on a host without a connector. */
  connectorGitHubInstallations: Pick<ConnectorGitHubInstallations, 'track'> | null = null

  private readonly botWriteListeners = new Set<() => void>()

  /** Every bot record save or removal on this host, for its own readers (webhooks, avatars, the
   *  connector's hello); clients hear `botsChanged`. */
  onBotsWritten(listener: () => void): () => void {
    this.botWriteListeners.add(listener)
    return () => this.botWriteListeners.delete(listener)
  }

  readonly bots = new BotController({
    getStore: () => this.store,
    notifyBotsWritten: (catalogChanged) => {
      if (catalogChanged) {
        this.notifyReposChanged()
      }
      this.botWriteListeners.forEach((listener) => listener())
      this.botChangeNotices.changed({ kinds: ['bot'] })
    },
    createFolderWorkspace: async (input) =>
      (await this.projectGroups.createFolderWorkspace(input)).folderWorkspace,
    deleteFolderWorkspace: (id) =>
      this.projectGroups.deleteFolderWorkspace(id, { discardUnsavedDrafts: true }),
    deleteBotAutomations: (botId) =>
      deleteAutomationsOfBot(this.store?.listAutomations?.() ?? [], botId, (id) =>
        this.deleteAutomation(id)
      ),
    botAgentChanged: (bot) =>
      void syncBotAutomationAgents(this.store?.listAutomations?.() ?? [], bot, (id, agentId) =>
        this.updateAutomation(id, { agentId })
      ).catch((error: unknown) => {
        console.warn("[bots] could not move the bot's automations to its new agent", error)
      }),
    leaveBotGroups: (botId) => this.leaveBotGroups(botId),
    botsRoot: () => botsRootFolder(),
    filesystem: localBotHomeFilesystem,
    accountUserId: () =>
      this.servedOrcaProfileId
        ? profileAccountUserId(this.servedOrcaProfileId, getProfileUserDataPath())
        : null,
    forgetBot: (botId) => {
      void this.botSharePicks()
        .forget(botId)
        .catch(() => undefined)
      this.lookAround.forget(botId)
      this.botWork.forgetBot(botId)
      this.bots.memory.removed(botId)
    }
  })

  private sharePicks: BotSharePicksStore | null = null

  /** Each bot's last published picks on this host; kept apart from the cloud client so a delete
   *  clears them on a runtime that never shares. */
  botSharePicks(): BotSharePicksStore {
    this.sharePicks ??= new BotSharePicksStore(
      join(getProfileUserDataPath(), 'bot-share-picks.json')
    )
    return this.sharePicks
  }

  private botShareClient: { client: BotShareClient; download: BotShareDownloadPolicy } | null = null
  private botShareService: BotShareService | null = null

  /** The desktop app hands in its Orca Cloud client and where shared bots download; the headless
   *  runtime has none. */
  setBotShareClient(client: BotShareClient, download: BotShareDownloadPolicy): void {
    this.botShareClient = { client, download }
    this.botShareService = null
  }

  /** Sharing bots by link, made on first use (it needs the app's data folder). */
  botShares(): BotShareService {
    if (!this.botShareClient) {
      throw new Error('Sharing a bot needs the Orca desktop app.')
    }
    const { client, download } = this.botShareClient
    this.botShareService ??= new BotShareService({
      client,
      download,
      candidates: new BotShareCandidates(join(getProfileUserDataPath(), 'bot-share-candidates')),
      picks: this.botSharePicks(),
      readShareable: (bot, skills) =>
        readBotShareable({
          bot,
          automations: this.store?.listAutomations?.() ?? [],
          repos: this.listRepos(),
          ...skills
        })
    })
    return this.botShareService
  }

  /** The scheduler's per-automation lane once bot automations bind to it; until then nothing runs there. */
  inAutomationLane: <T>(automationId: string, operation: () => Promise<T>) => Promise<T> = (
    _automationId,
    operation
  ) => operation()

  private botSessionHooks: BotSessionHooks = UNSET_BOT_SESSION_HOOKS

  /** Set by the runtime: a bot turn ended (bot-request-outcome.ts); a member session's group room;
   *  a bot's other chats lately; an owner item change's mail. */
  get botSessions(): BotSessionHooks {
    return this.botSessionHooks
  }

  /** With the real hooks in, item mail a restart left owed goes out, scheduler or not. */
  set botSessions(hooks: BotSessionHooks) {
    this.botSessionHooks = hooks
    this.botItems.startRecovery()
    this.botJournal.catchUp()
  }

  /** Each bot's looks and Up next, on this host. */
  readonly lookAround = new BotLookAroundStore(
    lookAroundFileIo(() => lookAroundStoreFile(getProfileUserDataPath())),
    () => {
      // A look or tidy-up marks its run's chat as no chat of the bot's.
      this.botChatTreeIndex?.lookAroundChanged()
      this.botChangeNotices.changed({ kinds: ['lookAround', 'chats'] })
    }
  )

  /** Each pane's Dispatch, as worktree ps reads it, for bot Activity. */
  agentOrchestrationByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    return this.agentOrchestrationProjection.buildByPaneKey()
  }

  /** The paired servers' rosters as last read, for an `@` pick and a send that misses here. */
  readonly pairedBotRosters = pairedBotRosterCache(this)

  /** What the work record reads: orchestration, worktrees and the conversation store. */
  private readonly botWorkRuntime: BotWorkRuntime & BotHomeLineage = {
    getOrchestrationDb: () => this.getOrchestrationDb(),
    resolveOrchestrationWorkerServer: (selector) => this.resolveOrchestrationWorkerServer(selector),
    callOrchestrationWorkerServer: (...args) => this.callOrchestrationWorkerServer(...args),
    getOrchestrationFleetAgentStatusSnapshot: () => this.getOrchestrationFleetAgentStatusSnapshot(),
    ensureStructuredAgentSessionHost: () => this.ensureStructuredAgentSessionHost(),
    // Read per call: the host binds it after this field initializes.
    getAgentStatusSnapshotFn: () => this.getAgentStatusSnapshotFn?.() ?? [],
    showManagedTerminalWorkspace: (selector) => this.showManagedTerminalWorkspace(selector),
    bots: this.bots,
    linkStore: () => this.store,
    listWorkspaceLineage: () => this.listWorkspaceLineage()
  }

  /** Which worker each bot conversation's code work went to. */
  readonly botWork = runtimeBotWork(this.botWorkRuntime)

  private readonly botJournal = journaledItemsNotice(this, (scope) =>
    this.botChangeNotices.changed(scope)
  )

  /** What each bot is doing for its owner and needs from them, on this host. */
  readonly botItems = runtimeBotItems({
    workRuntime: this.botWorkRuntime,
    bots: () => this.bots.list(),
    store: () => this.store,
    // Closed items also go to each bot's memory/journal/.
    notify: (scope) => this.botJournal(scope),
    sendMail: (mail) => this.botSessions.sendItemMail(mail)
  })

  protected override structuredMailReportItem = botItemOfReport(this.botItems)

  /** Whether a bot's work on this host opened this pull request as its owner: a live worker's, or a
   *  workspace under a bot's home with its head branch checked out. */
  async isBotWorkPullRequest(pr: OwnPullRequest): Promise<boolean> {
    const rows = botWorkRowsForRuntime(
      this.botWork,
      (botId) => this.listedBotLookup.hasId(botId),
      (worker, branch) => workerGitHubRepo(this.botWorkRuntime, worker, branch)
    )
    return (
      (await botWorkHasPrBranch(rows, pr)) ||
      (await botHomeWorktreeOnBranch(this.botWorkRuntime, pr.head, pr.headRef))
    )
  }

  abstract deleteAutomation(id: string): Promise<{ removed: boolean; id: string }>
  abstract updateAutomation(id: string, updates: { agentId: Bot['agent'] }): Promise<unknown>

  protected abstract scrubBotToolSecrets(bot: WiredBot): Promise<void>

  /** A bot session's gate on a queued message; the runtime overrides it. */
  protected assertStructuredQueuedMessageAllowed(_sessionId: string, _messageId: string): void {}

  private readonly listedBotLookup = createBotLookupIndex(() => this.bots.list())
  private readonly wiredBotLookup = createBotLookupIndex(() => this.wiredBots())

  /** The bots on this host's store, read per call. */
  protected wiredBots(): readonly WiredBot[] {
    return this.store?.getBots?.() ?? []
  }

  /** The structured host's bot side: their sessions' tools and memory, Look around, and the queued-message gate. */
  protected botStructuredSessionHostDeps(store: () => RuntimeStore) {
    return {
      ...botStructuredSessionWiring({
        store,
        botsAtInstall: this.store?.getBots?.() ?? [],
        bots: this.bots,
        chats: botChatJournal(),
        work: this.botWork,
        lookAround: this.lookAround,
        requestTurnEnded: (sessionId, turnId, ended) =>
          this.botSessions.turnEnded(sessionId, turnId, ended),
        recentChats: (botId, sessionId, message) =>
          this.botSessions.recentChats(botId, sessionId, message),
        unansweredQuestionNote: (sessionId) => this.botSessions.unansweredQuestionNote(sessionId),
        botChats: (bot, sessionId) => this.botSessions.chatsOf(bot, sessionId),
        pairedBotRosters: this.pairedBotRosters.read,
        scrubToolSecrets: (bot) => this.scrubBotToolSecrets(bot)
      }),
      assertQueuedMessageAllowed: (sessionId: string, messageId: string) =>
        this.assertStructuredQueuedMessageAllowed(sessionId, messageId),
      onMessageAdmitted: (message: AdmittedMessage) => this.onChatMessageAdmitted(message)
    }
  }

  abstract onChatMessageAdmitted(message: AdmittedMessage): void

  abstract isWorkspaceNotificationMuted(workspaceId: string): boolean

  /** A chat's phone attention: muted by its workspace's filters or its bot's switches, with its group room. */
  protected botAttentionDeliveryDeps() {
    const isWorkspaceMuted = (id: string) => this.isWorkspaceNotificationMuted(id)
    type Muted = Parameters<typeof isStructuredAttentionMuted>
    return {
      isMuted: (scope: Muted[1], news: Muted[2]) =>
        isStructuredAttentionMuted(
          { isWorkspaceMuted, bots: () => this.wiredBotLookup.byHomeList(scope.workspaceId) },
          scope,
          news
        ),
      readBotGroupRoom: (sessionId: string) => this.botSessions.groupRoomOf(sessionId),
      repliesInSlack: (id: string) => !!this.store && sessionRepliesInSlack(this.store, id)
    }
  }

  /** Gives installed bots' older background chats their rows once the chat host is up. */
  protected backfillBotBackgroundChats(): Promise<void> {
    return backfillInstalledBotBackgroundChats(() => this.wiredBots())
  }

  protected abstract leaveBotGroups(botId: string): Promise<void>

  abstract listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>>

  abstract showManagedTerminalWorkspace(
    worktreeSelector: string
  ): Promise<Pick<Worktree, 'displayName' | 'branch' | 'head' | 'linkedPR' | 'suppressedGitHubPR'>>

  /** Debounced `botsChanged` for clients showing a bot; every source of change calls it. */
  protected readonly botChangeNotices = new BotChangeNotices({
    emit: (scope) => {
      this.notifier?.botsChanged?.(scope)
      this.emitClientEvent({ type: 'botsChanged', ...scope })
    },
    hasBots: () => this.bots.list().length > 0,
    needsYouCounts: () => this.botItems.needsYouCounts(Date.now())
  })

  /** Each bot's chats-tree base between reads, kept from the record store's and database's own
   *  changes; set once the runtime is built (bot-chat-tree-host). */
  botChatTreeIndex: BotChatTreeIndex | null = null
  /** Settled workers the chats tree read, kept until their Dispatch's rows change. */
  readonly botChatTreeWorkers = new BotChatTreeWorkerCache()

  // Setup cards in every window and phone re-read the bot's Google setup run on this notice.
  protected readonly stopGoogleSetupNotices = googleSetupRuns().onChange(() =>
    this.botChangeNotices.changed({ kinds: ['settings'] })
  )

  // A tool's sign-in state shows in every window's and phone's rows: they re-read the tools on this,
  // and when a credential ends (a tool removed, a sign-in replaced).
  protected readonly stopToolSignInNotices = [
    onBotToolSignInChanged(() => this.botChangeNotices.changed({ kinds: ['settings'] })),
    onBotToolCredentialEnded(() => this.botChangeNotices.changed({ kinds: ['settings'] }))
  ]

  /** Something a bot's settings or cards show changed on this host; windows and phones re-read.
   *  Unscoped, every reader re-reads. */
  notifyBotsChanged(scope: BotChangeScope = {}): void {
    this.botChangeNotices.changed(scope)
  }

  /** This host's waiting access requests changed; windows and phones re-read them. */
  notifyBotAccessRequestsChanged(): void {
    this.botChangeNotices.changed({ kinds: ['access'] })
  }

  /** A group's room, members or latest message changed; windows and phones re-read the groups. */
  notifyBotGroupsChanged(): void {
    this.botChangeNotices.changed({ kinds: ['groups'] })
  }

  /** A paired server's worker verdicts changed: their bots re-read (all, if a bot can't be read). */
  protected botFederatedWorkersChanged(dispatchIds: readonly string[]): void {
    this.botChatTreeWorkers.drop(dispatchIds)
    const botIds = this.botChatTreeIndex?.ownersOf(dispatchIds) ?? null
    if (botIds?.length !== 0) {
      this.botChangeNotices.changed({ ...(botIds ? { botIds } : {}), kinds: ['workers'] })
    }
  }

  protected botDispatchChanged(dispatchId: string | null, change: DispatchRowChange): void {
    this.botChatTreeWorkers.rowChanged(dispatchId, change)
    if (change !== 'deleted') {
      this.botItems.dispatchChanged(dispatchId)
    }
    if (this.botChatTreeIndex) {
      this.botChatTreeIndex.dispatchLinkChanged(dispatchId, change)
    } else {
      this.botChangeNotices.changed({ kinds: ['workers'] })
    }
  }
}
