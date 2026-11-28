import { crewChatStatusChange } from '../../orchestration/crew/crew-changes'
import { resolveHostStructuredAgentLaunchEnvironment } from '../launch/structured-agent-launch-support'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from './structured-agent-session-runtime'
import {
  createStructuredAttentionMobileDelivery,
  readStructuredAttentionWorkspaceLabels
} from '../lifecycle/structured-agent-session-mobile-attention'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../../../agent-hooks/first-work/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../../../agent-hooks/first-work/first-work-rename-runtime'
import { createStructuredChatNamingHandler } from '../../../native-chat/structured-chat-naming'
import { structuredChatNamingDeps } from '../naming/structured-chat-naming-runtime'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { chatWorkerTurnStopReporter } from '../../orchestration/workers/turn-stops/chat-worker-turn-stops'
import {
  structuredWorkerOpenTaskTitle,
  structuredWorkerOwesWork
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-custody'
import { structuredAgentSettingGates } from '../launch/structured-agent-setting-gates'
import { claudeCliFlagSupport } from '../../../claude/cli-capabilities/claude-cli-flag-support'
import { nativeChatIdleStopMs } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { prWatchWorkspaceSources } from '../lifecycle/pr-watch-workspace-sources'
import { startPRWatchRuntime } from '../lifecycle/pr-watch-runtime'
import { workerDockFailureSink } from '../../orchestration/dock/worker-dock-provider-failures'
import { workerDockSourceOfSession } from '../../orchestration/dock/worker-dock-source'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { StructuredAgentSessionStatusSink } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-ownership'

type StructuredHostDeps = Exclude<
  Parameters<typeof installStructuredAgentSessionHost>[0],
  () => unknown
>
type StructuredAttentionDeps = Parameters<typeof createStructuredAttentionMobileDelivery>[0]
type TurnStopReporterDeps = Parameters<typeof chatWorkerTurnStopReporter>[0]
type FirstWorkRenameStore = Parameters<typeof firstWorkRenameDeps>[0]
type FirstWorkRenameRuntime = Parameters<typeof firstWorkRenameDeps>[1]
type NamingStore = ReturnType<Parameters<typeof structuredChatNamingDeps>[0]>
type NamingRuntime = Parameters<typeof structuredChatNamingDeps>[1]
type PrWatchSourcesRuntime = Parameters<typeof prWatchWorkspaceSources>[0]

export type RuntimePullRequestWatchBootstrapContext = PrWatchSourcesRuntime & {
  legacySessionTabIds: readonly string[]
}

export function startRuntimePullRequestWatches(
  context: RuntimePullRequestWatchBootstrapContext,
  options: { admit?: boolean } = {}
): Promise<void> {
  return startPRWatchRuntime(
    {
      stateDirectory: getProfileUserDataPath(),
      legacySessionTabIds: context.legacySessionTabIds,
      hostId: LOCAL_EXECUTION_HOST_ID,
      logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger()),
      ...prWatchWorkspaceSources({
        resolveRuntimeFileTarget: context.resolveRuntimeFileTarget,
        store: context.store
      })
    },
    options
  )
}

export type RuntimeStructuredAgentSessionHostBootstrapContext = {
  legacySessionTabIds: StructuredHostDeps['legacySessionTabIds']
  claimKeyId: StructuredHostDeps['claimKeyId']
  requireStore: () => RuntimeStore & FirstWorkRenameStore & NamingStore
  resolveRuntimeFileTarget: PrWatchSourcesRuntime['resolveRuntimeFileTarget']
  getCommitMessageAgentEnvironmentResolvers: NamingRuntime['getAgentEnvResolvers']
  getOrchestrationDbIfAvailable: () => OrchestrationDb | null
  getExistingOrchestrationDb: () => OrchestrationDb | null
  getOrchestrationDb: () => OrchestrationDb
  readWorkerDockSource: (
    source: string
  ) => ReturnType<NonNullable<StructuredHostDeps['readWorkerDockPresence']>>
  refreshStructuredConversationTabTitle: NonNullable<NamingRuntime['retitleOpenTab']>
  structuredAgentCatalogDependencies: () => ReturnType<
    OrcaRuntimeService['structuredAgentCatalogDependencies']
  >
  botStructuredSessionHostDeps: (
    requireStore: () => RuntimeStore
  ) => ReturnType<OrcaRuntimeService['botStructuredSessionHostDeps']>
  usageLimitAutoContinueHostDeps: () => StructuredHostDeps['usageLimitAutoContinue']
  resolveStructuredAgentLaunchAccountHome: NonNullable<StructuredHostDeps['launchAccountHome']>
  prepareStructuredAgentLaunchAccountHome: NonNullable<
    StructuredHostDeps['prepareLaunchAccountHome']
  >
  onStructuredRequestFailureForErrorMail: NonNullable<StructuredHostDeps['onRequestFailure']>
  onStructuredIdleProviderDeathForMail: NonNullable<StructuredHostDeps['onIdleProviderDeath']>
  notifyCrewChanges: (change: ReturnType<typeof crewChatStatusChange>) => void
  onStructuredSessionStatusForMail: (
    summary: Parameters<NonNullable<StructuredHostDeps['onSessionStatusChanged']>>[0]
  ) => void
  observeWorkerAutoReleaseChat: (
    summary: Parameters<NonNullable<StructuredHostDeps['onSessionStatusChanged']>>[0]
  ) => void
  firstWorkRenameRuntime: FirstWorkRenameRuntime
  structuredAgentStatusSinkFn: StructuredAgentSessionStatusSink | null
  onStructuredSessionTabHidden: NonNullable<StructuredHostDeps['onSessionTabHidden']>
  structuredChatMailOwed: NonNullable<StructuredHostDeps['queuedAgentMessageOwed']>
  assertStructuredChatAcquireAdmissible: NonNullable<StructuredHostDeps['assertNoTerminalWriter']>
  botAttentionDeliveryDeps: () => ReturnType<OrcaRuntimeService['botAttentionDeliveryDeps']>
  readOrchestrationForPaneKey: NonNullable<StructuredAttentionDeps['readOrchestration']>
  dispatchMobileNotification: StructuredAttentionDeps['dispatch']
  reconcileStructuredPromptAttention: StructuredAttentionDeps['reconcile']
  workerTurnStopReportDeps: Omit<TurnStopReporterDeps, 'openExistingDb'>
  backfillBotBackgroundChats: () => Promise<void>
}

export async function ensureRuntimeStructuredAgentSessionHost(
  context: RuntimeStructuredAgentSessionHostBootstrapContext
): Promise<void> {
  // Built only when this call installs: deps run install-time work such as each bot's tool-secret sweep.
  await installStructuredAgentSessionHost(() => {
    const logger = createStructuredAgentSessionLogger()
    const nameChat = createStructuredChatNamingHandler(
      structuredChatNamingDeps(
        () => context.requireStore(),
        {
          resolveWorkspace: async (workspaceId) => {
            const target = await context.resolveRuntimeFileTarget(`id:${workspaceId}`)
            return { path: target.worktree.path, executionHostId: target.executionHostId }
          },
          getAgentEnvResolvers: () => context.getCommitMessageAgentEnvironmentResolvers(),
          resolveNamingEnvironment: (agent) =>
            resolveHostStructuredAgentLaunchEnvironment(
              agent,
              context.requireStore().getSettings()
            ),
          workerTaskTitle: (record) =>
            structuredWorkerOpenTaskTitle(context.getOrchestrationDbIfAvailable(), record),
          retitleOpenTab: (workspaceId, sessionId) =>
            context.refreshStructuredConversationTabTitle(workspaceId, sessionId)
        },
        logger
      )
    )
    return {
      legacySessionTabIds: context.legacySessionTabIds,
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: context.claimKeyId,
      logger,
      ...context.structuredAgentCatalogDependencies(),
      ...context.botStructuredSessionHostDeps(() => context.requireStore()),
      claudeCliFlags: claudeCliFlagSupport,
      usageLimitAutoContinue: context.usageLimitAutoContinueHostDeps(),
      idleSweep: { idleMs: () => nativeChatIdleStopMs(context.requireStore().getSettings()) },
      nativeChatVisuals: {
        isEnabled: () => context.requireStore().getSettings().nativeChatInlineVisuals !== false
      },
      ...structuredAgentSettingGates(() => context.requireStore().getSettings()),
      launchAccountHome: (record, purpose) =>
        context.resolveStructuredAgentLaunchAccountHome(record, purpose),
      prepareLaunchAccountHome: (record, launchDirectory) =>
        context.prepareStructuredAgentLaunchAccountHome(record, launchDirectory),
      onRequestFailure: (failure) => context.onStructuredRequestFailureForErrorMail(failure),
      onIdleProviderDeath: (death) => context.onStructuredIdleProviderDeathForMail(death),
      readWorkerDockPresence: (sessionId) =>
        context.readWorkerDockSource(workerDockSourceOfSession(sessionId)),
      // Structured chat has no CLI hooks; this projection drives first-work renaming.
      onSessionStatusChanged: (summary, options) => {
        context.notifyCrewChanges(crewChatStatusChange(summary.sessionId))
        context.onStructuredSessionStatusForMail(summary)
        context.observeWorkerAutoReleaseChat(summary)
        nameChat(summary, options)
        void maybeAutoRenameWorkspaceOnFirstStructuredTurn(
          summary,
          options,
          firstWorkRenameDeps(context.requireStore(), context.firstWorkRenameRuntime)
        )
      },
      statusSink: workerDockFailureSink(context.structuredAgentStatusSinkFn, {
        getOrchestrationDb: context.getOrchestrationDb
      }),
      conversationNaming: nameChat,
      onSessionTabHidden: (sessionId) => context.onStructuredSessionTabHidden(sessionId),
      queuedAgentMessageOwed: (sessionId, from) => context.structuredChatMailOwed(sessionId, from),
      assertNoTerminalWriter: (record) => context.assertStructuredChatAcquireAdmissible(record),
      attentionDelivery: createStructuredAttentionMobileDelivery({
        readNotificationSettings: () => context.requireStore().getSettings().notifications,
        readWorkspaceLabels: (scope) =>
          readStructuredAttentionWorkspaceLabels(context.requireStore(), scope),
        ...context.botAttentionDeliveryDeps(),
        // The same contexts the session's chat row carries.
        readOrchestration: (paneKey) => context.readOrchestrationForPaneKey(paneKey),
        dispatch: (event) => context.dispatchMobileNotification(event),
        reconcile: (state) => context.reconcileStructuredPromptAttention(state)
      }),
      createTurnAttention: () =>
        chatWorkerTurnStopReporter({
          ...context.workerTurnStopReportDeps,
          openExistingDb: () => context.getExistingOrchestrationDb()
        }),
      // Re-read dispatch ownership each sweep; absence of a database cannot keep the worker alive.
      hasOpenDispatch: (record) =>
        structuredWorkerOwesWork(context.getOrchestrationDbIfAvailable(), record)
    }
  }).then(() => context.backfillBotBackgroundChats())
}
