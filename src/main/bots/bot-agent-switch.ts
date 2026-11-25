import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  newChatPermissionModeForSettings
} from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { providerSwitchPermission } from '../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import type { BotAgentSwitchPreviewResult } from '../../shared/rpc-contract/bots-params'
import { providerSwitchSourcePermission } from '../native-chat/agent-session-wire/delivery/structured-agent-session-provider-switch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'

export function previewBotAgentSwitch(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  agent: BotAgent
): BotAgentSwitchPreviewResult {
  const choice =
    bot.permissionMode ??
    newChatPermissionModeForSettings(bot.agent, runtime.requireStore().getSettings())
  const defaultPermission = isAgentChatPermissionMode(choice) ? choice : 'ask'
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
      broadensHome || broadensDefault ? { agent, from: bot.agent, defaultPermission, home } : null
  }
}

export async function changeBotAgentInPlace(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  next: Bot,
  consent: NonNullable<BotAgentSwitchPreviewResult['consent']> | undefined,
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
  const previousPermission =
    bot.permissionMode ?? newChatPermissionModeForSettings(bot.agent, settings)
  const nextPermission =
    next.permissionMode ?? newChatPermissionModeForSettings(next.agent, settings)
  const maximum = providerSwitchPermission(previousPermission, next.agent)
  if (
    isAgentChatPermissionMode(nextPermission) &&
    AGENT_CHAT_PERMISSION_MODES.indexOf(nextPermission) >
      AGENT_CHAT_PERMISSION_MODES.indexOf(maximum.permission)
  ) {
    next.permissionMode = maximum.permission
  }
  const sessionId = bot.chatSessionId
  if (!sessionId || !host.deps.store.getConversation(sessionId)) {
    await save()
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
    save
  )
  if (result.status === 'consent-required') {
    throw new Error('Home Chat permissions changed. Review the agent switch again.')
  }
}
