// The owner's comment attachments, admitted on the bot's host as chat admits its own: images are
// committed inline-image files in this host's chat attachment store, under chat's limits; files ride in
// the text as `@path`. Every store upload the comment names is claimed for the item's chat before the
// event is written, so the chat's claims and sweep keep it exactly as long as that chat's own pastes.
import { copyFile, lstat, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import {
  AGENT_SESSION_ATTACHMENTS_DIR_NAME,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
} from '../../shared/agent-session/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentInlineImagePath } from '../../shared/native-chat/input/composer/agent-inline-image-types'
import type { BotItemCommentImage } from '../../shared/bots/bot-items'
import {
  agentSessionAttachmentReferences,
  parseAgentSessionAttachmentStorePath
} from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { isAgentSessionAttachmentExpiredError } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import type { AgentSessionAttachmentClaimer } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { BotItemError } from './bot-item-error'

const MB = 1024 * 1024
// Any chat-attachment store path, this host's or not: with no store to read, none can be told apart.
const STORE_REFERENCE = new RegExp(
  `${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
  'i'
)

export type BotItemCommentAttachmentDeps = {
  store: Pick<AgentSessionAttachmentStore, 'rootDir' | 'isUploadInFlight' | 'storeWith'> | null
  /** This host's own window commented: an image it dropped from disk is copied into the store, as
   *  the store holds every comment image. A paired client names store paths only. */
  local: boolean
  claim: AgentSessionAttachmentClaimer | null
  /** The item's chat's live session and title; null when that chat is gone. */
  chat: () => Promise<{ sessionId: string; title: string | null } | null>
}

/** The comment's images, named and sized on this host, once each upload it names is claimed for the
 *  item's chat; a text-only comment naming no upload touches nothing. */
export async function admitBotItemCommentAttachments(
  deps: BotItemCommentAttachmentDeps,
  text: string,
  paths: readonly string[]
): Promise<BotItemCommentImage[]> {
  const { store } = deps
  if (!store) {
    // Unclaimed bytes would be swept under the comment, so anything naming an upload waits for the store.
    if (paths.length > 0 || STORE_REFERENCE.test(text)) {
      throw refused("This computer can't take attachments right now. Comment again in a moment.")
    }
    return []
  }
  const stored = deps.local
    ? await Promise.all(paths.map((path) => storedCopy(store, path)))
    : paths
  const images = await admitImages(store, stored)
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      ...images.map(({ path }) => ({ type: 'image-ref' as const, path }))
    ]
  }
  if (agentSessionAttachmentReferences(store.rootDir, body).size === 0) {
    return images
  }
  const chat = await deps.chat()
  if (!chat) {
    throw refused("This item's chat was deleted, so files can't be attached here.")
  }
  if (!deps.claim) {
    throw refused("Couldn't attach the files. Comment again in a moment.")
  }
  try {
    await deps.claim(chat.sessionId, body)
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      const names = error.expired.map(({ name }) => name).join(', ')
      throw refused(`${names}: this attachment expired. Attach it again.`)
    }
    console.warn('[bots] items: claiming comment attachments failed', error)
    throw refused("Couldn't attach the files. Comment again in a moment.")
  }
  return images
}

async function admitImages(
  store: NonNullable<BotItemCommentAttachmentDeps['store']>,
  paths: readonly string[]
): Promise<BotItemCommentImage[]> {
  if (paths.length > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
    throw refused(`Comments take up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT} images.`)
  }
  const root = paths.length > 0 ? await realpath(store.rootDir).catch(() => null) : null
  const images: BotItemCommentImage[] = []
  let total = 0
  for (const path of new Set(paths)) {
    const stored = parseAgentSessionAttachmentStorePath(store.rootDir, path)
    if (!stored || !root || !isAgentInlineImagePath(stored.name)) {
      throw refused('Only pasted or attached images can go on a comment.')
    }
    if (store.isUploadInFlight(stored.uploadId)) {
      throw refused(`${stored.name} is still uploading.`)
    }
    const info = await lstat(path).catch(() => null)
    // A symlink, folder or swapped path is refused like a missing one: only the committed file.
    const real = info?.isFile() ? await realpath(path).catch(() => null) : null
    if (!info?.isFile() || real !== join(root, stored.uploadId, stored.name)) {
      throw refused(`${stored.name}: this attachment expired. Attach it again.`)
    }
    if (info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      throw refused(`${stored.name} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`)
    }
    total += info.size
    images.push({ path, name: stored.name, bytes: info.size })
  }
  if (total > AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES) {
    throw refused(
      `These images add up to ${Math.ceil(total / MB)} MB. A comment takes up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES / MB} MB.`
    )
  }
  return images
}

/** A local image outside the store, copied in; a store path as it is. */
async function storedCopy(
  store: NonNullable<BotItemCommentAttachmentDeps['store']>,
  path: string
): Promise<string> {
  if (
    !isAbsolute(path) ||
    !isAgentInlineImagePath(path) ||
    parseAgentSessionAttachmentStorePath(store.rootDir, path)
  ) {
    return path
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw refused(`${basename(path)} can't be read.`)
  }
  if (info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
    throw refused(`${basename(path)} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`)
  }
  return store.storeWith(basename(path), (part) => copyFile(path, part))
}

function refused(message: string): BotItemError {
  return new BotItemError('invalid_argument', message)
}
