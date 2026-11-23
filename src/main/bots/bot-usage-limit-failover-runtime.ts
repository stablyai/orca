// Wires BotUsageLimitGate and BotUsageLimitFailover to OrcaRuntimeService, host sessions and RateLimitService.
import type { AgentJournalBotBackupModelSwitchItem } from '../../shared/agent-journal-orca-card-items'
import type { BotAgent } from '../../shared/bot-types'
import { isBotAgent } from '../../shared/bot-types'
import type {
  BotBackupModelEntry,
  BotBackupStatusResult
} from '../../shared/bots/bot-backup-models'
import { agentSessionAccountHomePath } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { rateLimitSpentUntil } from '../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { usageLimitContinueMutation } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-continue-message'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { hostReadyBotAgents } from '../runtime/rpc/methods/bots-agent-choices'
import { botOfSession } from './bot-session-tabs'
import { startBotSession } from './bot-chat-session'
import { closeReplacedBotChat } from './bot-chat-replacement'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import { showBotSessionTab } from './bot-session-tab-show'
import { notifyBotTurnWatchRebind } from './bot-run-turn-watch'
import { checkStartupBackupReturns, readBotBackupStatus } from './bot-backup-status-read'
import { BotUsageLimitGate, type BotUsageLimitKey } from './bot-usage-limit-gate'
import { BotUsageLimitFailover } from './bot-usage-limit-failover'

const AVAILABLE_AGENTS_CACHE_MS = 15_000

export type RuntimeBotBackupFailover = {
  readonly gate: BotUsageLimitGate
  readonly failover: BotUsageLimitFailover
  readonly readStatus: (botId: string) => Promise<BotBackupStatusResult>
  readonly dispose: () => void
}

async function applySameAgentOptionsOnHost(
  sessionId: string,
  target: BotBackupModelEntry
): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(sessionId)
  if (!host || !record) {
    return false
  }
  const caller = { callerKey: 'trusted-local:bot-backup-failover' }
  const writeOption = async (key: string, value: string): Promise<boolean> => {
    const latest = host.deps.store.getRecord(sessionId)
    if (!latest) {
      return false
    }
    const res = await host.setOption(caller, {
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: latest.lease.runtimeFence,
        payloadFingerprint: ''
      },
      key,
      value
    })
    return res.ok
  }
  if (target.model && !(await writeOption('model', target.model))) {
    return false
  }
  if (target.options) {
    for (const [key, value] of Object.entries(target.options)) {
      if (key !== 'model') {
        await writeOption(key, value).catch(() => false)
      }
    }
  }
  return true
}

export function createRuntimeBotUsageLimitFailover(
  runtime: OrcaRuntimeService
): RuntimeBotBackupFailover {
  let cachedAgents: { at: number; agents: ReadonlySet<BotAgent> } | null = null

  const availableAgents = async (): Promise<ReadonlySet<BotAgent>> => {
    const now = Date.now()
    if (cachedAgents && now - cachedAgents.at < AVAILABLE_AGENTS_CACHE_MS) {
      return cachedAgents.agents
    }
    const choices = await hostReadyBotAgents(runtime).catch((): BotAgent[] => [])
    const agents = new Set<BotAgent>(choices)
    if (agents.size > 0) {
      cachedAgents = { at: now, agents }
    }
    return agents
  }

  const resolveAccountHomeKey = async (agent: BotAgent, sessionId?: string): Promise<string> => {
    const host = getStructuredAgentSessionHost()
    if (sessionId && host) {
      const record = host.deps.store.getRecord(sessionId)
      if (record) {
        const home =
          (await host.deps.launchAccountHome?.(record).catch(() => null)) ?? record.accountHome
        return agentSessionAccountHomePath(home) ?? 'default'
      }
    }
    const home = await runtime.resolveStructuredAgentAccountHome(agent, 'catalog').catch(() => null)
    return (home && agentSessionAccountHomePath(home)) || 'default'
  }

  const readSpentUntil = async (key: BotUsageLimitKey): Promise<number | null | undefined> => {
    if (key.agent !== 'claude' && key.agent !== 'codex') {
      return undefined
    }
    const reading = runtime.getUsageRateLimits()?.usageReading(key.agent)
    return reading?.status === 'ok' ? rateLimitSpentUntil(reading) : undefined
  }

  let failoverRef: BotUsageLimitFailover | null = null
  const gate = new BotUsageLimitGate({
    readSpentUntil,
    onLimitReleased: (key) => {
      void failoverRef?.onLimitReleased(key).catch(() => {})
    },
    onLimitChanged: () => {
      runtime.notifyBotsChanged({ kinds: ['settings'] })
    }
  })

  const appendSwitchCard = async (
    sessionId: string,
    item: AgentJournalBotBackupModelSwitchItem,
    at: number
  ): Promise<void> => {
    const host = getStructuredAgentSessionHost()
    const destination = host ? await host.captureAgentStartDestination(sessionId) : null
    if (host && destination) {
      await host.appendAgentStart(destination, item, at)
    }
  }

  const failover = new BotUsageLimitFailover({
    gate,
    listBots: () => runtime.bots.list(),
    botOfSession: (sessionId) => botOfSession(runtime.bots, sessionId),
    updateBot: (botId, edit) => runtime.bots.update(botId, edit),
    getSessionInfo: async (sessionId) => {
      const host = getStructuredAgentSessionHost()
      const record = host?.deps.store.getRecord(sessionId)
      if (!host || !record || !isBotAgent(record.provider)) {
        return null
      }
      const work = await host.currentWork(sessionId).catch(() => null)
      return {
        sessionId,
        provider: record.provider,
        ...(record.options?.model ? { model: record.options.model } : {}),
        isIdle: !work || (!work.working() && !work.hasActionablePrompt()),
        runtimeFence: record.lease.runtimeFence
      }
    },
    resolveAccountHomeKey,
    availableAgents,
    applySameAgentOptions: applySameAgentOptionsOnHost,
    sendSameAgentContinuation: async (sessionId, cut, runtimeFence) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return false
      }
      const mutation = await usageLimitContinueMutation({
        sessionId,
        cut,
        at: Date.now(),
        expectedRuntimeFence: runtimeFence
      })
      const result = await host.send({ callerKey: 'trusted-local:bot-backup-failover' }, mutation)
      return result.ok
    },
    appendSwitchCard,
    publishSessionStatus: (sessionId) => {
      const host = getStructuredAgentSessionHost()
      if (host) {
        void host.readUsageLimitContinue(sessionId).catch(() => {})
      }
      runtime.notifyBotsChanged({ kinds: ['chats', 'settings'] })
    },
    listBotSessionIds: (botId) => {
      const bot = runtime.bots.list().find((entry) => entry.id === botId)
      const host = getStructuredAgentSessionHost()
      if (!bot || !host) {
        return []
      }
      const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
      const ids = new Set<string>([
        ...host.deps.store.listVisibleSessionIds(),
        ...host.deps.store.listBackgroundSessionIds()
      ])
      return [...ids].filter(
        (id) => host.deps.store.getConversation(id)?.location.workspaceId === homeKey
      )
    },
    readSessionCut: async (sessionId) => {
      const reads = await getStructuredAgentSessionHost()
        ?.journalReads(sessionId)
        .catch(() => null)
      return reads ? reads.usageLimitCut() : null
    },
    crossAgentHandoff: {
      readContinuationContext: async (sessionId, workspaceId) => {
        const host = getStructuredAgentSessionHost()
        const history = host
          ? await host.history({ sessionId, direction: 'tail' }).catch(() => null)
          : null
        if (!host || !history?.ok) {
          return null
        }
        const expectedCursor =
          history.page.liveCursor ?? history.page.window.newest ?? history.page.window.nextCursor
        return host.continuationContext({ sessionId, workspaceId, expectedCursor })
      },
      readConversationName: (sessionId) =>
        getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.conversationName,
      isBackgroundSession: (sessionId) =>
        getStructuredAgentSessionHost()?.deps.store.isSessionInBackground(sessionId) === true,
      isTabVisible: (sessionId) =>
        getStructuredAgentSessionHost()?.deps.store.isSessionTabVisible(sessionId) === true,
      readActsFor: (sessionId) =>
        runtime.getOrchestrationDb().getBotConversationActsFor(sessionId) ?? null,
      startSession: (botOnTarget, input) =>
        startBotSession(runtime, botOnTarget, {
          sessionId: input.sessionId,
          background: input.background,
          actsFor: input.actsFor,
          message: { text: input.text, clientMessageId: input.clientMessageId },
          skipBackupResolve: true
        }),
      setHomeChatSession: async (botId, sessionId) => {
        await runtime.bots.setChatSession(botId, sessionId)
      },
      carryQueuedMessages: async (fromSessionId, toSessionId) => {
        const host = getStructuredAgentSessionHost()
        if (host) {
          await carryQueuedMessages(host, fromSessionId, toSessionId)
        }
      },
      closeOldHomeChat: async (sessionId) => {
        await closeReplacedBotChat(runtime, sessionId)
      },
      showTab: (bot, sessionId) => showBotSessionTab(runtime, bot, sessionId),
      nameSession: async (sessionId, name) => {
        await getStructuredAgentSessionHost()?.setUserConversationName(sessionId, name, 'rename')
      },
      appendSwitchCard,
      linkStore: () => {
        try {
          return runtime.requireStore()
        } catch {
          return null
        }
      },
      onSessionHandedOff: (fromSessionId, toSessionId) => {
        runtime.lookAround.rebindSession(fromSessionId, toSessionId)
        notifyBotTurnWatchRebind(fromSessionId, toSessionId)
        runtime.notifyBotsChanged({ kinds: ['chats', 'bot'] })
      }
    }
  })
  failoverRef = failover

  queueMicrotask(() =>
    checkStartupBackupReturns(runtime.bots.list(), { gate, failover, resolveAccountHomeKey })
  )
  const onCatalogWarmed = (): void => runtime.notifyBotsChanged({ kinds: ['settings'] })
  const statusDeps = { runtime, gate, availableAgents, resolveAccountHomeKey, onCatalogWarmed }
  return {
    gate,
    failover,
    readStatus: (botId) => readBotBackupStatus(statusDeps, botId),
    dispose: () => gate.dispose()
  }
}

const runtimeFailovers = new WeakMap<OrcaRuntimeService, RuntimeBotBackupFailover>()

export function runtimeBotBackupFailover(runtime: OrcaRuntimeService): RuntimeBotBackupFailover {
  const existing = runtimeFailovers.get(runtime)
  if (existing) {
    return existing
  }
  const instance = createRuntimeBotUsageLimitFailover(runtime)
  runtimeFailovers.set(runtime, instance)
  return instance
}

export function peekRuntimeBotBackupFailover(
  runtime: OrcaRuntimeService
): RuntimeBotBackupFailover | null {
  return runtimeFailovers.get(runtime) ?? null
}
