// `send --on <server> --to bot:<name> --file`: each file is copied to the paired Orca's attachment
// store first, with the upload calls a desktop uses to paste into a server's chat; the mail then names
// the stored paths, and that Orca admits them into the chat the mail lands in: the item's with
// `--item`, else the `--chat` it names or the bot's Home Chat. Mail that can't carry them sends nothing.
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../../../shared/schema/lazy-zod-schema'
import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  sanitizeAgentSessionAttachmentName,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
} from '../../../../../../shared/agent-session/agent-session-attachments'
import { BOT_ITEM_COMMENT_FILE_MAX_COUNT } from '../../../../../../shared/bots/bot-items'
import { isAgentInlineImagePath } from '../../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { parseBotAddress } from '../../../../../../shared/bot-roster'
import { BOT_NEW_CHAT } from './bot-chat-address'
import { uploadBufferWith } from '../../../../../ipc/agent-attachments/agent-session-attachment-upload'
import type { PeerMailServer } from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

const CALL_TIMEOUT_MS = 30_000
const MB = 1024 * 1024
const ShownItem = lazyZodSchema(() =>
  z.object({ item: z.object({ chat: z.object({ id: z.string().min(1) }) }) })
)

function refused(message: string): OrchestrationError {
  return new OrchestrationError('invalid_argument', `${message} Nothing was sent.`, {
    effectsApplied: false
  })
}

type PeerMailFilesParams = { to?: string; chat?: string; item?: string; files?: string[] }

/** `--file` with `--on` goes to a bot, into a chat it has; refused before the server is asked. */
export function assertPeerMailFilesAddress(params: PeerMailFilesParams): void {
  if (!params.files?.length) {
    return
  }
  if (!params.to || parseBotAddress(params.to) === null) {
    throw refused(
      '--file with --on goes to a bot there: --to bot:<name>. To share text with an agent, paste it with --body-file.'
    )
  }
  if (params.chat === BOT_NEW_CHAT) {
    throw refused(
      '--file goes into a chat the bot already has: drop --chat new to use its Home Chat, or name one with --chat <id>.'
    )
  }
}

/** Refused before anything is uploaded when the server's Orca can't take these files. */
export function assertPeerMailServerTakesFiles(
  server: PeerMailServer,
  params: PeerMailFilesParams
): void {
  if (!params.files?.length) {
    return
  }
  if (params.item !== undefined ? !server.takesFiles : !server.takesChatFiles) {
    throw refused(
      `${server.name}'s Orca needs an update to receive files${params.item !== undefined ? '' : ' without --item'}.`
    )
  }
}

/** The paired Orca's store paths for `files`, in order; undefined when there are none. */
export async function uploadPeerMailFiles(
  runtime: Pick<OrcaRuntimeService, 'callOrchestrationWorkerServer'>,
  server: PeerMailServer,
  params: PeerMailFilesParams
): Promise<string[] | undefined> {
  const files = params.files ?? []
  if (files.length === 0) {
    return undefined
  }
  assertPeerMailFilesAddress(params)
  assertPeerMailServerTakesFiles(server, params)
  const bot = parseBotAddress(params.to ?? '') ?? ''
  // The limits a local `send --item --file` has, checked before anything is uploaded.
  // The paired Orca classifies by the name it stores, so classify by that name too.
  const isImage = files.map((path) =>
    isAgentInlineImagePath(sanitizeAgentSessionAttachmentName(basename(path)))
  )
  const imageCount = isImage.filter(Boolean).length
  if (imageCount > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
    throw refused(`A message takes up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT} images.`)
  }
  if (files.length - imageCount > BOT_ITEM_COMMENT_FILE_MAX_COUNT) {
    throw refused(`A message takes up to ${BOT_ITEM_COMMENT_FILE_MAX_COUNT} files besides images.`)
  }
  const sizes = await Promise.all(
    files.map(async (path) => {
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) {
        throw refused(`${basename(path)} can't be read.`)
      }
      if (info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
        throw refused(`${basename(path)} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`)
      }
      return info.size
    })
  )
  const imageBytes = sizes.reduce((sum, size, index) => (isImage[index] ? sum + size : sum), 0)
  if (imageBytes > AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES) {
    throw refused(
      `These images add up to ${Math.ceil(imageBytes / MB)} MB. A message takes up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES / MB} MB.`
    )
  }
  const call = (method: string, params: unknown) =>
    runtime.callOrchestrationWorkerServer(
      server.environmentId,
      method,
      params,
      CALL_TIMEOUT_MS,
      undefined,
      {
        expectedEnvironmentPairingRevision: server.pairingRevision
      }
    )
  const target = await uploadTarget(call, server, params.item, bot)
  const stored: string[] = []
  for (const [index, path] of files.entries()) {
    const buffer = await readFile(path)
    if (buffer.byteLength !== sizes[index]) {
      throw refused(`${basename(path)} changed while it was sent.`)
    }
    const { path: storedPath } = await uploadBufferWith(call, target, basename(path), buffer)
    stored.push(storedPath)
  }
  return stored
}

/** Uploads with an item belong to the item's chat there, which the item names; other bot mail's go
 *  to the bot, and its Orca claims them for the chat the mail lands in. */
async function uploadTarget(
  call: (method: string, params: unknown) => Promise<unknown>,
  server: PeerMailServer,
  item: string | undefined,
  bot: string
): Promise<string> {
  if (item === undefined) {
    return `bot:${bot}`
  }
  const shown = ShownItem.safeParse(await call('bots.items.owner.show', { item, newest: true }))
  if (!shown.success) {
    throw refused(`${server.name} didn't say which chat item ${item} is in.`)
  }
  return shown.data.item.chat.id
}
