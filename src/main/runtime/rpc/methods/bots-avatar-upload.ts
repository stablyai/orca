import { isCompleteBotAvatarPng } from '../../../bots/bot-avatar-png'
import { MAX_BOT_AVATAR_BYTES } from '../../../../shared/bot-avatar'
import { getAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { structuredCallerFor } from './structured-sessions/creation/structured-agent-session-gate'
import { BotAvatarUpload } from '../../../../shared/rpc-contract/bots-params'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { BOT_TOKEN_ENDED, botOfToken } from '../../../bots/bot-of-caller'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

function ownAvatarCaller(botToken: string, context: RpcContext) {
  const { runtime } = context
  const refusal = 'Set your picture from your own bot chat on the computer that runs it.'
  if (context.caller?.kind !== 'local-cli' || context.pairedDeviceId !== undefined) {
    throw new InvalidArgumentError(refusal)
  }
  const caller = botOfToken(runtime, botToken, context.pairedDeviceId)
  if (caller.kind !== 'bot') {
    throw new InvalidArgumentError(caller.kind === 'ended' ? BOT_TOKEN_ENDED : refusal)
  }
  const session = sessionCallerOf(context.orchestrationCaller)
  if (
    !session ||
    session.terminalHandle !== null ||
    !botOfHomeWorkspace([caller.bot], session.workspaceId) ||
    runtime.lookAround.botOfLook(session.sessionId) ||
    runtime.lookAround.botOfTidyUp(session.sessionId)
  ) {
    throw new InvalidArgumentError(refusal)
  }
  return { botId: caller.bot.id, sessionId: session.sessionId }
}

export const BOT_AVATAR_UPLOAD_METHOD = defineMethod({
  name: 'bots.avatar.upload',
  permission: 'workspace',
  params: BotAvatarUpload,
  handler: async (params, context) => {
    if ('botId' in params) {
      ownerOnly(context, 'Only the owner can choose a bot’s picture by name in Orca.')
      return {
        bot: await context.runtime.bots.setAvatarImage(
          params.botId,
          Buffer.from(params.png, 'base64')
        )
      }
    }
    const { botId, sessionId } = ownAvatarCaller(params.botToken, context)
    const store = getAgentSessionAttachmentStore()
    if (!store) {
      throw new InvalidArgumentError('Chat uploads are unavailable on this host.')
    }
    const png = await store.takeUploadBytes(
      structuredCallerFor(context).callerKey,
      sessionId,
      params.uploadId,
      MAX_BOT_AVATAR_BYTES
    )
    if (!(await isCompleteBotAvatarPng(png))) {
      throw new InvalidArgumentError(
        'The PNG is damaged or incomplete. Export a square 512 to 2000 pixel PNG and retry.'
      )
    }
    return { bot: await context.runtime.bots.setAvatarImage(botId, png) }
  }
})
