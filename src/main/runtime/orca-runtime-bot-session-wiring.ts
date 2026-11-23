import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import type { Bot } from '../../shared/bot-types'
import type { BotController } from '../bots/bot-controller'
import { botChatJournal } from '../bots/bot-chat-reads'
import type { BotLookAroundStore } from '../bots/bot-look-around-store'
import { botStructuredSessionWiring, type WiredBot } from '../bots/bot-structured-session-wiring'
import type { BotSessionHooks } from '../bots/bot-turn-ended'
import type { BotTurnWorkTargetRegistry } from '../bots/bot-turn-work-target'
import type { BotWorkRecord } from '../bots/bot-work-record'
import {
  createBotWorkTargetValidator,
  type BotWorkTargetWorkspaceSummary
} from '../bots/bot-work-target-validation'
import type { KnownPairedBotRoster } from '../bots/paired-bot-rosters'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { RuntimeStore } from './construction/runtime-store-contract'

export type RuntimeBotSessionHostOwner = {
  bots: Pick<BotController, 'endFirstRun' | 'memory'>
  botWork: Pick<BotWorkRecord, 'turnNote' | 'handedOver' | 'turnEnded'>
  botWorkTargets: BotTurnWorkTargetRegistry
  lookAround: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp' | 'lookTurnIsQuiet'>
  botSessions: BotSessionHooks
  pairedBotRosters: {
    read: (servers: ReadonlySet<string>) => Promise<readonly KnownPairedBotRoster[]>
  }
  showManagedTerminalWorkspace: (
    selector: string,
    requiredHostId?: ExecutionHostId
  ) => Promise<BotWorkTargetWorkspaceSummary>
  resolveOrchestrationWorkerServer: (selector: string) => Promise<{
    environmentId: string
    name: string
    pairingRevision?: number
    peerFingerprint?: string
  }>
  callOrchestrationWorkerServer: (
    environmentId: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    options?: { orchestrationRequestId?: string },
    pairingFence?: { expectedEnvironmentPairingRevision?: number }
  ) => Promise<unknown>
  onChatMessageAdmitted: (message: AdmittedMessage) => void
}

export type RuntimeBotSessionProtectedHooks = {
  botsAtInstall: readonly Bot[]
  isBotHome: (workspaceId: string) => boolean
  clientName: (installationId: string) => string | null
  scrubBotToolSecrets: (bot: WiredBot) => Promise<void>
  assertQueuedMessageAllowed: (sessionId: string, messageId: string) => void
}

/** Assemble the structured-session host's bot hooks, work-target validation, and queued-message gate. */
export function buildRuntimeBotStructuredSessionHostDeps(
  owner: RuntimeBotSessionHostOwner,
  store: () => RuntimeStore,
  hooks: RuntimeBotSessionProtectedHooks
) {
  const validateWorkTarget = createBotWorkTargetValidator({
    hostId: LOCAL_EXECUTION_HOST_ID,
    isBotHome: hooks.isBotHome,
    store,
    showManagedTerminalWorkspace: (selector, requiredHostId) =>
      owner.showManagedTerminalWorkspace(selector, requiredHostId),
    resolveOrchestrationWorkerServer: (selector) =>
      owner.resolveOrchestrationWorkerServer(selector),
    callOrchestrationWorkerServer: (...args) => owner.callOrchestrationWorkerServer(...args)
  })
  return {
    ...botStructuredSessionWiring({
      store,
      botsAtInstall: hooks.botsAtInstall,
      bots: owner.bots,
      chats: botChatJournal(),
      work: owner.botWork,
      workTargets: owner.botWorkTargets,
      validateWorkTarget,
      sessionRecord: (sessionId) =>
        getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId) ?? null,
      lookAround: owner.lookAround,
      requestTurnEnded: (sessionId, turnId, ended) =>
        owner.botSessions.turnEnded(sessionId, turnId, ended),
      recentChats: (botId, sessionId) => owner.botSessions.recentChats(botId, sessionId),
      unansweredQuestionNote: (sessionId, botId) =>
        owner.botSessions.unansweredQuestionNote(sessionId, botId),
      botChats: (bot, sessionId) => owner.botSessions.chatsOf(bot, sessionId),
      pairedBotRosters: owner.pairedBotRosters.read,
      clientName: hooks.clientName,
      scrubToolSecrets: hooks.scrubBotToolSecrets
    }),
    assertQueuedMessageAllowed: hooks.assertQueuedMessageAllowed,
    onMessageAdmitted: (message: AdmittedMessage) => owner.onChatMessageAdmitted(message)
  }
}
