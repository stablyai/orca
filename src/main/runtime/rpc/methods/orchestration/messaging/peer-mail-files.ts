// `send --on <server> --to bot:<name> --item <n> --file`: each file is copied to the paired Orca's
// attachment store first, with the upload calls a desktop uses to paste into a server's chat; the mail
// then names the stored paths, and that Orca admits them into the item's chat.
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
import { uploadBufferWith } from '../../../../../ipc/agent-attachments/agent-session-attachment-upload'
import type { OrchestrationWorkerServer } from '../../../../orchestration/federation/environment-transport'
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

/** The paired Orca's store paths for `files`, in order; undefined when there are none. */
export async function uploadPeerMailFiles(
  runtime: Pick<OrcaRuntimeService, 'callOrchestrationWorkerServer'>,
  server: OrchestrationWorkerServer,
  params: { to?: string; item?: string; files?: string[] }
): Promise<string[] | undefined> {
  const files = params.files ?? []
  if (files.length === 0) {
    return undefined
  }
  if (params.item === undefined || !params.to || parseBotAddress(params.to) === null) {
    throw refused("--file goes with --to bot:<name> --item <n>: the files go to that item's chat.")
  }
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
  // Uploads belong to the item's chat there, which the item names.
  const shown = ShownItem.safeParse(
    await call('bots.items.owner.show', { item: params.item, newest: true })
  )
  if (!shown.success) {
    throw refused(`${server.name} didn't say which chat item ${params.item} is in.`)
  }
  const stored: string[] = []
  for (const [index, path] of files.entries()) {
    const buffer = await readFile(path)
    if (buffer.byteLength !== sizes[index]) {
      throw refused(`${basename(path)} changed while it was sent.`)
    }
    const { path: storedPath } = await uploadBufferWith(
      call,
      shown.data.item.chat.id,
      basename(path),
      buffer
    )
    stored.push(storedPath)
  }
  return stored
}
