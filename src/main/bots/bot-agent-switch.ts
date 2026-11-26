import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  isAgentChatPermissionChoice,
  newChatPermissionModeForSettings
} from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { providerSwitchPermission } from '../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import type { BotAgentSwitchPreviewResult } from '../../shared/rpc-contract/bot-agent-switch-params'
import { providerSwitchSourcePermission } from '../native-chat/agent-session-wire/delivery/structured-agent-session-provider-selection'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { InvalidArgumentError } from '../runtime/rpc/core'

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
  const record = bot.chatSessionId ? host.deps.store.getConversation(bot.chatSessionId) : null
  const home = record
    ? {
        sessionId: record.sessionId,
        from: record.provider,
        permission: providerSwitchSourcePermission(record)
      }
    : null
  const broadensHome =
    home && home.from !== agent && providerSwitchPermission(home.permission, agent).requiresConsent
  const broadensDefault =
    bot.agent !== agent && providerSwitchPermission(defaultPermission, agent).requiresConsent
  return {
    consent:
      broadensHome || broadensDefault ? { agent, from: bot.agent, defaultPermission, home } : null,
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
    saveExplicitAsk
  }: {
    consent?: NonNullable<BotAgentSwitchPreviewResult['consent']>
    saveExplicitAsk?: true
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
      consent?.home?.permission !== expected.home?.permission)
  ) {
    throw new Error('Confirm that the new agent may use tools without Orca approval.')
  }
  const settings = runtime.requireStore().getSettings()
  const inherits = next.permissionMode === undefined
  const approveFixedAsk = (settingsAtSave: typeof settings) => {
    const expected = inherits && inheritedBotPermissionWouldBroaden(bot, next.agent, settingsAtSave)
    if (expected !== (saveExplicitAsk === true)) {
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
  const sessionId = bot.chatSessionId
  if (!sessionId || !host.deps.store.getConversation(sessionId)) {
    await saveDefault()
    return
  }
  const home = expected?.home
  const result = await host.selectProvider(
    {
      sessionId,
      agent: next.agent,
      options: botLaunchSeedOptions(next.launch),
      ...(home
        ? {
            consent: { from: home.from, fromPermission: home.permission, permission: 'full-access' }
          }
        : {})
    },
    { botId: bot.id, save: saveDefault }
  )
  if (result.status === 'consent-required') {
    throw new Error('Home Chat permissions changed. Review the agent switch again.')
  }
}
