import { BotAgentSwitchPreview } from '../../../../shared/rpc-contract/bot-agent-switch-params'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { requireStructuredHost, runtimeBotChats } from '../../../bots/bot-chat-session'
import { changeBotAgentInPlace, previewBotAgentSwitch } from '../../../bots/bot-agent-switch'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

export async function updateBotWithAgentSwitch(params: BotUpdateParams, context: RpcContext) {
  const { runtime } = context
  const { agent, agentSwitchConsent, agentSwitchSaveExplicitAsk } = params.updates
  if (agentSwitchConsent || agentSwitchSaveExplicitAsk) {
    ownerOnly(context, 'Only the owner can approve broader access for a bot.')
    if (context.plugin) {
      throw new InvalidArgumentError('Approve broader bot access in Orca.')
    }
  }
  if (agent === undefined) {
    return runtime.bots.update(params.botId, params.updates)
  }
  if (!context.clientCapabilities?.includes(AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY)) {
    return runtime.bots.update(params.botId, (current) => {
      if (agent !== current.agent) {
        throw new InvalidArgumentError('Update Orca before switching this bot’s agent.')
      }
      return params.updates
    })
  }
  return runtimeBotChats(runtime).withDefaultChange(params.botId, async () => {
    const host = await requireStructuredHost(runtime)
    return runtime.bots.update(params.botId, params.updates, (current, next, save) =>
      changeBotAgentInPlace(
        runtime,
        host,
        current,
        next,
        {
          consent: agentSwitchConsent,
          saveExplicitAsk: agentSwitchSaveExplicitAsk
        },
        save
      )
    )
  })
}

export const BOT_AGENT_SWITCH_PREVIEW_METHOD = defineMethod({
  name: 'bots.agentSwitchPreview',
  permission: 'workspace',
  params: BotAgentSwitchPreview,
  handler: async ({ botId, agent }, { runtime }) => {
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new InvalidArgumentError('Bot not found.')
    }
    return previewBotAgentSwitch(runtime, await requireStructuredHost(runtime), bot, agent)
  }
})
