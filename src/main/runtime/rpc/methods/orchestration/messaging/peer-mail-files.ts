// `send --on <server> --to bot:<name> --file`: each file is copied to the paired Orca's attachment
// store first, with the upload calls a desktop uses to paste into a server's chat; the mail then names
// the stored paths, and that Orca admits them into the chat the mail lands in: the item's with
// `--item`, else the `--chat` it names or the bot's Home Chat. Mail that can't carry them sends nothing.
import { open, type FileHandle } from 'node:fs/promises'
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
import { isBotRequestPurpose } from '../../../../../bots/bot-request-policy'
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

type PeerMailFilesParams = {
  to?: string
  chat?: string
  item?: string
  type?: string
  files?: string[]
}

/** `--file` with `--on` goes to a bot, into a chat it has; refused before the server is asked. */
export function assertPeerMailFilesAddress(params: PeerMailFilesParams): void {
  if (!params.files?.length) {
    return
  }
  if (!params.to || parseBotAddress(params.to) === null) {
    throw refused(
      '--file with --on works only when sending to a bot there: --to bot:<name>. To share text with an agent, paste it with --body-file.'
    )
  }
  if (!isBotRequestPurpose(params.type ?? 'status')) {
    throw refused('--file only works with --type status, handoff or question.')
  }
  if (params.item !== undefined && params.chat !== undefined) {
    throw refused('Pass --item or --chat, not both.')
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
  // Every file is opened and sized before the first upload, so one that can't be read sends nothing,
  // and each upload reads the file it sized.
  const opened = await openAll(files)
  try {
    const sizes = opened.map(({ size }) => size)
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
    try {
      for (const [index, path] of files.entries()) {
        const buffer = await opened[index]!.handle.readFile()
        if (buffer.byteLength !== sizes[index]) {
          throw refused(`${basename(path)} changed while it was sent.`)
        }
        const { path: storedPath } = await uploadBufferWith(call, target, basename(path), buffer)
        stored.push(storedPath)
      }
    } catch (error) {
      throw withUnattachedUploads(error, server, stored.length)
    }
    return stored
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})))
  }
}

/** Each file opened for reading, with its size; refused, with nothing left open, when one can't be. */
async function openAll(files: string[]): Promise<{ handle: FileHandle; size: number }[]> {
  const opened: { handle: FileHandle; size: number }[] = []
  try {
    for (const path of files) {
      const handle = await open(path, 'r').catch(() => null)
      const info = await handle?.stat().catch(() => null)
      if (handle) {
        opened.push({ handle, size: info?.size ?? 0 })
      }
      if (!info?.isFile()) {
        throw refused(`${basename(path)} can't be read.`)
      }
      if (info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
        throw refused(`${basename(path)} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`)
      }
    }
    return opened
  } catch (error) {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})))
    throw error
  }
}

// The server may yet have stored mail that ends in one of these: its answer never came back.
const MAYBE_DELIVERED = new Set([
  'runtime_timeout',
  'remote_runtime_unavailable',
  'delivery_in_progress',
  'operation_unknown',
  'outcome_unknown'
])

/** The server answered that it refused the mail, so none of it is stored there. */
export function peerMailStoredNothing(error: unknown): boolean {
  if (!(error instanceof OrchestrationError) || MAYBE_DELIVERED.has(error.code)) {
    return false
  }
  const data: unknown = error.data
  return (
    typeof data !== 'object' ||
    data === null ||
    !('effectsApplied' in data) ||
    data.effectsApplied === false
  )
}

/** A send that certainly stored no mail, after files reached the server, says so: the message wasn't
 *  sent, and those files wait there, attached to nothing, until that Orca clears its unused uploads. */
export function withUnattachedUploads(
  error: unknown,
  server: Pick<PeerMailServer, 'name'>,
  count: number
): unknown {
  if (count === 0) {
    return error
  }
  const files = count === 1 ? 'A file' : `${count} files`
  const note = `${files} already copied to ${server.name} for it ${count === 1 ? 'is' : 'are'} attached to nothing there; Orca on ${server.name} clears unused uploads later.`
  const known = error instanceof OrchestrationError
  // The cause, then what happened, then what to do: a retry hint moves to the end.
  const text = error instanceof Error ? error.message : String(error)
  const again = / ?Send it again\.$/.test(text) ? ' Send it again.' : ''
  const reason = text
    .replace(/ ?Send it again\.$/, '')
    .replace(/ ?(Nothing was sent|No message was sent|Nothing was delivered)\.$/, '')
    .replace(/([^.])$/, '$1.')
  const data = known && typeof error.data === 'object' && error.data !== null ? error.data : {}
  return new OrchestrationError(
    known ? error.code : 'peer_mail_not_sent',
    `${reason} The message wasn't sent. ${note}${again}`,
    { ...data, effectsApplied: true, unattachedUploads: count }
  )
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
