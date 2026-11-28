import { isBotAgent, type Bot } from '../../shared/bot-types'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  providerSwitchPermission,
  type AgentSessionSelectProviderParams,
  type AgentSessionSelectProviderResult
} from '../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { botLaunchFromChoices } from '../../shared/bots/bot-launch'
import { providerSwitchSourcePermission } from '../native-chat/agent-session-wire/delivery/structured-agent-session-provider-selection'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { changeBotAgentInPlace, previewBotAgentSwitch } from './bot-agent-switch'
import { runtimeBotChats } from './bot-chat-session'
import { botHomeFolder } from './bot-home'
import { linkBotOwnSkills } from './bot-own-skills'

function permissionRank(permission: AgentChatPermissionChoice): number {
  return isAgentChatPermissionMode(permission) ? AGENT_CHAT_PERMISSION_MODES.indexOf(permission) : 0
}

export async function selectBotProviderFromComposer(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  bot: Bot,
  params: AgentSessionSelectProviderParams
): Promise<AgentSessionSelectProviderResult> {
  if (!isBotAgent(params.agent)) {
    return host.selectProvider(params)
  }
  const targetAgent = params.agent
  return runtimeBotChats(runtime).withDefaultChange(bot.id, async () => {
    const current = runtime.bots.list().find((entry) => entry.id === bot.id)
    const record = host.deps.store.getConversation(params.sessionId)
    if (!current || !record) {
      return host.selectProvider(params)
    }
    if (targetAgent === current.agent && record.provider === targetAgent) {
      return host.selectProvider(params)
    }
    if (targetAgent === current.agent) {
      return host.selectProvider(params, { botId: current.id, save: async () => {} })
    }
    const preview = previewBotAgentSwitch(runtime, host, current, targetAgent)
    if (preview.consent) {
      const candidates: {
        sessionId: string
        from: string
        permission: AgentChatPermissionChoice
        clicked?: boolean
      }[] = []
      if (
        preview.consent.home &&
        preview.consent.home.from !== targetAgent &&
        providerSwitchPermission(preview.consent.home.permission, targetAgent).requiresConsent
      ) {
        candidates.push({
          ...preview.consent.home,
          clicked: preview.consent.home.sessionId === params.sessionId
        })
      }
      for (const session of preview.consent.sessions ?? []) {
        candidates.push({
          ...session,
          clicked: session.sessionId === params.sessionId
        })
      }
      if (
        preview.consent.from !== targetAgent &&
        providerSwitchPermission(preview.consent.defaultPermission, targetAgent).requiresConsent
      ) {
        candidates.push({
          sessionId: '',
          from: preview.consent.from,
          permission: preview.consent.defaultPermission
        })
      }
      candidates.sort((left, right) => {
        const diff = permissionRank(left.permission) - permissionRank(right.permission)
        if (diff !== 0) {
          return diff
        }
        return (right.clicked ? 1 : 0) - (left.clicked ? 1 : 0)
      })
      const strictest = candidates[0] ?? {
        from: record.provider,
        permission: providerSwitchSourcePermission(record)
      }
      if (
        params.consent?.from !== strictest.from ||
        params.consent.fromPermission !== strictest.permission ||
        params.consent.permission !== 'full-access'
      ) {
        return {
          status: 'consent-required',
          from: strictest.from,
          fromPermission: strictest.permission
        }
      }
    }
    const launch =
      botLaunchFromChoices({
        model: params.options?.model,
        options: params.options
      }) ?? null
    const updated = await runtime.bots.update(
      current.id,
      { agent: targetAgent, launch },
      (botNow, next, save) =>
        changeBotAgentInPlace(
          runtime,
          host,
          botNow,
          next,
          {
            consent: preview.consent ?? undefined,
            allowImplicitAskClamp: true
          },
          save
        )
    )
    void linkBotOwnSkills(botHomeFolder(updated)).catch(() => {})
    return { status: 'selected' }
  })
}
