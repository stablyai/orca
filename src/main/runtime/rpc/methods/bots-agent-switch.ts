import { BotAgentSwitchPreview } from '../../../../shared/rpc-contract/bot-agent-switch-params'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { requireStructuredHost, runtimeBotChats } from '../../../bots/bot-chat-session'
import { changeBotAgentInPlace, previewBotAgentSwitch } from '../../../bots/bot-agent-switch'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

export async function updateBotWithAgentSwitch(params: BotUpdateParams, context: RpcContext) {
  const { runtime } = context
  if (params.updates.agentSwitchConsent) {
    ownerOnly(context, 'Only the owner can approve broader access for a bot.')
    if (context.plugin) {
      throw new InvalidArgumentError('Approve broader bot access in Orca.')
    }
  }
  return params.updates.agent === undefined
    ? await runtime.bots.update(params.botId, params.updates)
    : await runtimeBotChats(runtime).withDefaultChange(params.botId, async () => {
        const host = await requireStructuredHost(runtime)
        return runtime.bots.update(params.botId, params.updates, (current, next, save) =>
          changeBotAgentInPlace(
            runtime,
            host,
            current,
            next,
            params.updates.agentSwitchConsent,
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
