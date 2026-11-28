import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  isAgentChatPermissionChoice,
  newChatPermissionModeForSettings,
  type AgentChatPermissionChoice
} from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  providerSwitchPermission,
  type AgentSessionProviderSelection
} from '../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import type {
  BotAgentSwitchPreviewResult,
  BotAgentSwitchSessionConsent
} from '../../shared/rpc-contract/bot-agent-switch-params'
import { providerSwitchSourcePermission } from '../native-chat/agent-session-wire/delivery/structured-agent-session-provider-selection'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { clearedInto } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { InvalidArgumentError } from '../runtime/rpc/core'
import { isBotBackgroundRun } from './bot-background-run-records'
import { captureBotGroupPreConsentOperations, runtimeBotGroups } from './bot-group-runtime'

type SessionConsentSummary = {
  sessionId: string
  from: string
  permission: AgentChatPermissionChoice
}

function listBotSwitchTargetSessions(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  agent: BotAgent
): AgentSessionConversationView[] {
  const targets = new Map<string, AgentSessionConversationView>()
  const home = bot.chatSessionId ? host.deps.store.getConversation(bot.chatSessionId) : null
  if (home && host.deps.canSwitchProvider?.(home.sessionId, agent) !== false) {
    targets.set(home.sessionId, home)
  }
  const conversations = host.deps.store.listConversations?.() ?? []
  const groupStore =
    typeof runtime.getOrchestrationDb === 'function' ? runtimeBotGroups(runtime).store : null
  const others: AgentSessionConversationView[] = []
  for (const record of conversations) {
    if (targets.has(record.sessionId)) {
      continue
    }
    if (!botOfHomeWorkspace([bot], record.location.workspaceId)) {
      continue
    }
    if (clearedInto(record) !== null) {
      continue
    }
    if (runtime.lookAround && isBotBackgroundRun(runtime.lookAround, record)) {
      continue
    }
    if (host.deps.canSwitchProvider?.(record.sessionId, agent) === false) {
      continue
    }
    if (isBotGroupMemberSession(record.sessionId)) {
      if (!groupStore || groupStore.memberOf(record.sessionId)?.member.botId !== bot.id) {
        continue
      }
    }
    others.push(record)
  }
  others.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  for (const record of others) {
    targets.set(record.sessionId, record)
  }
  return [...targets.values()]
}

function sessionConsentSummary(record: AgentSessionConversationView): SessionConsentSummary {
  return {
    sessionId: record.sessionId,
    from: record.provider,
    permission: providerSwitchSourcePermission(record)
  }
}

function sessionConsentListsMatch(
  left: readonly BotAgentSwitchSessionConsent[] | undefined,
  right: readonly BotAgentSwitchSessionConsent[] | undefined
): boolean {
  const a = left ?? []
  const b = right ?? []
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (entry, index) =>
      entry.sessionId === b[index]?.sessionId &&
      entry.from === b[index]?.from &&
      entry.permission === b[index]?.permission
  )
}

function inheritedBotPermissionWouldBroaden(
  bot: Bot,
  agent: BotAgent,
  settings: Parameters<typeof newChatPermissionModeForSettings>[1]
): boolean {
  if (bot.agent === agent || bot.permissionMode !== undefined) {
    return false
  }
  const inherited = newChatPermissionModeForSettings(agent, settings)
  const source =
    bot.agent === 'pi' ? 'full-access' : newChatPermissionModeForSettings(bot.agent, settings)
  const previous = providerSwitchPermission(source, agent)
  return (
    isAgentChatPermissionMode(inherited) &&
    AGENT_CHAT_PERMISSION_MODES.indexOf(inherited) >
      AGENT_CHAT_PERMISSION_MODES.indexOf(previous.permission)
  )
}

export function previewBotAgentSwitch(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  agent: BotAgent
): BotAgentSwitchPreviewResult {
  const settings = runtime.requireStore().getSettings()
  const choice = bot.permissionMode ?? newChatPermissionModeForSettings(bot.agent, settings)
  const defaultPermission = isAgentChatPermissionChoice(choice) ? choice : 'ask'
  const targets = listBotSwitchTargetSessions(runtime, host, bot, agent)
  const homeRecord = bot.chatSessionId
    ? (targets.find((record) => record.sessionId === bot.chatSessionId) ?? null)
    : null
  const home = homeRecord ? sessionConsentSummary(homeRecord) : null
  const broadeningSessions = targets
    .filter((record) => record.sessionId !== bot.chatSessionId)
    .map(sessionConsentSummary)
    .filter(
      (entry) =>
        entry.from !== agent && providerSwitchPermission(entry.permission, agent).requiresConsent
    )
  const broadensHome =
    home && home.from !== agent && providerSwitchPermission(home.permission, agent).requiresConsent
  const broadensDefault =
    bot.agent !== agent && providerSwitchPermission(defaultPermission, agent).requiresConsent
  return {
    consent:
      broadensHome || broadensDefault || broadeningSessions.length > 0
        ? {
            agent,
            from: bot.agent,
            defaultPermission,
            home,
            ...(broadeningSessions.length > 0 ? { sessions: broadeningSessions } : {})
          }
        : null,
    ...(inheritedBotPermissionWouldBroaden(bot, agent, settings) ? { saveExplicitAsk: true } : {})
  }
}

export async function changeBotAgentInPlace(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  next: Bot,
  {
    consent,
    saveExplicitAsk,
    allowImplicitAskClamp
  }: {
    consent?: NonNullable<BotAgentSwitchPreviewResult['consent']>
    saveExplicitAsk?: true
    allowImplicitAskClamp?: boolean
  },
  save: () => Promise<void>
): Promise<void> {
  const expected = previewBotAgentSwitch(runtime, host, bot, next.agent).consent
  if (
    expected &&
    (consent?.agent !== expected.agent ||
      consent?.from !== expected.from ||
      consent?.defaultPermission !== expected.defaultPermission ||
      consent?.home?.sessionId !== expected.home?.sessionId ||
      consent?.home?.from !== expected.home?.from ||
      consent?.home?.permission !== expected.home?.permission ||
      !sessionConsentListsMatch(consent?.sessions, expected.sessions))
  ) {
    throw new Error('Confirm that the new agent may use tools without Orca approval.')
  }
  const settings = runtime.requireStore().getSettings()
  const inherits = next.permissionMode === undefined
  const approveFixedAsk = (settingsAtSave: typeof settings) => {
    const needsAsk = inherits && inheritedBotPermissionWouldBroaden(bot, next.agent, settingsAtSave)
    if (allowImplicitAskClamp) {
      if (needsAsk) {
        next.permissionMode = 'ask'
      }
      return
    }
    if (needsAsk !== (saveExplicitAsk === true)) {
      throw new InvalidArgumentError(
        'Review the bot’s permission setting and confirm the agent switch again.'
      )
    }
  }
  approveFixedAsk(settings)
  const saveDefault = () => {
    approveFixedAsk(runtime.requireStore().getSettings())
    return save()
  }
  const previousPermission =
    bot.permissionMode ?? newChatPermissionModeForSettings(bot.agent, settings)
  const nextPermission =
    next.permissionMode ?? newChatPermissionModeForSettings(next.agent, settings)
  const maximum = providerSwitchPermission(previousPermission, next.agent)
  if (saveExplicitAsk) {
    next.permissionMode = 'ask'
  } else if (
    (!inherits || bot.permissionMode !== undefined) &&
    isAgentChatPermissionMode(nextPermission) &&
    AGENT_CHAT_PERMISSION_MODES.indexOf(nextPermission) >
      AGENT_CHAT_PERMISSION_MODES.indexOf(maximum.permission)
  ) {
    next.permissionMode = maximum.permission
  }
  if (expected) {
    await captureBotGroupPreConsentOperations(runtime, bot.id)
  }
  const targets = listBotSwitchTargetSessions(runtime, host, bot, next.agent)
  if (targets.length === 0) {
    await saveDefault()
    return
  }
  const consentBySession = new Map<string, SessionConsentSummary>()
  if (expected?.home) {
    consentBySession.set(expected.home.sessionId, expected.home)
  }
  for (const entry of expected?.sessions ?? []) {
    consentBySession.set(entry.sessionId, entry)
  }
  const seedOptions = botLaunchSeedOptions(next.launch)
  const [primary, ...rest] = targets
  const staged: { sessionId: string; previous: AgentSessionProviderSelection | null }[] = []
  const rollback = async () => {
    for (const entry of staged.toReversed()) {
      await host.deps.store
        .updateRecord(entry.sessionId, {
          kind: 'select-provider',
          selection: entry.previous,
          now: Date.now()
        })
        .catch(() => undefined)
    }
  }
  const selectOne = async (target: AgentSessionConversationView, saveStep: () => Promise<void>) => {
    const approved = consentBySession.get(target.sessionId)
    const result = await host.selectProvider(
      {
        sessionId: target.sessionId,
        agent: next.agent,
        options: seedOptions,
        ...(approved
          ? {
              consent: {
                from: approved.from,
                fromPermission: approved.permission,
                permission: 'full-access'
              }
            }
          : {})
      },
      { botId: bot.id, save: saveStep }
    )
    if (result.status === 'consent-required') {
      throw new Error('Chat permissions changed. Review the agent switch again.')
    }
  }
  try {
    for (const target of rest) {
      const previous = host.deps.store.getRecord(target.sessionId)?.selectedProvider ?? null
      await selectOne(target, async () => {})
      staged.push({ sessionId: target.sessionId, previous })
    }
    await selectOne(primary, saveDefault)
  } catch (error) {
    await rollback()
    throw error
  }
}
