import {
  agentSessionAttachmentAppends,
  type AgentSessionAttachmentUploadStartResult
} from '../../shared/agent-session/agent-session-attachments'
import { resolve } from 'node:path'
import {
  readInjectedAgentSessionId,
  readInjectedBotToken
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  BOT_AVATAR_SIZE,
  MAX_BOT_AVATAR_SIZE,
  MAX_BOT_AVATAR_BYTES,
  isBotAvatarImage
} from '../../shared/bot-avatar'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/file-content/node-bounded-file-reader'
import { getRequiredStringFlag } from '../arguments/flags'
import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'

export const BOT_AVATAR_HANDLERS: Record<string, CommandHandler> = {
  'bot avatar set': async ({ flags, client, cwd, json }) => {
    const path = resolve(cwd, getRequiredStringFlag(flags, 'file'))
    const botToken = readInjectedBotToken()
    const callerSessionId = readInjectedAgentSessionId()
    if (client.isRemote || !botToken || !callerSessionId) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Run this from your own bot chat on the computer that runs it.'
      )
    }
    const { buffer } = await readNodeFileWithinLimit(path, MAX_BOT_AVATAR_BYTES, {
      regularFileOnly: true
    }).catch((error: unknown) => {
      if (error instanceof NodeFileReadTooLargeError) {
        throw new RuntimeClientError(
          'invalid_argument',
          `The picture is ${error.observedBytes} bytes. Use a PNG of at most ${error.maxBytes} bytes (2 MiB).`
        )
      }
      throw error
    })
    if (!isBotAvatarImage(buffer)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Use a square PNG, ${BOT_AVATAR_SIZE} to ${MAX_BOT_AVATAR_SIZE} pixels per side.`
      )
    }
    const {
      result: { uploadId }
    } = await client.call<AgentSessionAttachmentUploadStartResult>(
      'agentSessionAttachment.uploadStart',
      {
        sessionId: callerSessionId,
        name: 'avatar.png',
        byteLength: buffer.byteLength
      }
    )
    try {
      for (const chunk of agentSessionAttachmentAppends(buffer.toString('base64'))) {
        await client.call('agentSessionAttachment.uploadAppend', { uploadId, ...chunk })
      }
      const reply = await client.call<{ bot: { name: string } }>('bots.avatar.upload', {
        botToken,
        uploadId
      })
      printResult(reply, json, ({ bot }) => `Updated the picture for ${bot.name}.`)
    } catch (error) {
      await client.call('agentSessionAttachment.uploadAbort', { uploadId }).catch(() => {})
      throw error
    }
  }
}
