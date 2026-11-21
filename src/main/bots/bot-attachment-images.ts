// Shared chat-attachment admission for bots (item comments and group rooms): copies local desktop
// files into this host's attachment store, validates committed store image paths under chat limits,
// and claims referenced uploads against owning structured sessions.
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
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { isAgentSessionAttachmentExpiredError } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import type { AgentSessionAttachmentClaimer } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

const MB = 1024 * 1024
// Any chat-attachment store path, this host's or not: with no store to read, none can be told apart.
const STORE_REFERENCE = new RegExp(
  `${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
  'i'
)

export type BotAttachmentStore = Pick<
  AgentSessionAttachmentStore,
  'rootDir' | 'isUploadInFlight' | 'storeWith'
>

export type BotAttachmentImage = { path: string; name: string; bytes: number }

export type BotAttachmentErrorFactory = (message: string) => Error

export type BotAttachmentImageLabels = {
  /** Plural subject for count errors (e.g. "Comments" or "Group messages"). */
  plural: string
  /** Singular subject for total-size errors (e.g. "A comment" or "A group message"). */
  singular: string
  /** Surface phrase for invalid-path errors (e.g. "on a comment" or "in a group message"). */
  surface: string
}

export function hasAttachmentStoreReference(text: string): boolean {
  return STORE_REFERENCE.test(text)
}

/** A local image (or with `anyKind`, any file) outside the store, copied in; a store path as it is. */
export async function copyLocalAttachmentToStore(
  store: BotAttachmentStore,
  path: string,
  refused: BotAttachmentErrorFactory,
  anyKind = false
): Promise<string> {
  if (
    !isAbsolute(path) ||
    (!anyKind && !isAgentInlineImagePath(path)) ||
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

/** Refuses, before any image is copied in, a count or total over the chat limits: each outside image
 *  is copied (a repeated one too), a store image counts once as admitStoredAttachmentImages does. */
export async function assertLocalImagesFit(
  store: BotAttachmentStore,
  paths: readonly string[],
  labels: BotAttachmentImageLabels,
  refused: BotAttachmentErrorFactory
): Promise<void> {
  if (paths.length > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
    throw refused(`${labels.plural} take up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT} images.`)
  }
  const counted = new Set<string>()
  const sizes = await Promise.all(
    paths.map(async (path) => {
      if (!isAbsolute(path)) {
        return 0
      }
      if (parseAgentSessionAttachmentStorePath(store.rootDir, path)) {
        if (counted.has(path)) {
          return 0
        }
        counted.add(path)
      }
      return (await stat(path).catch(() => null))?.size ?? 0
    })
  )
  const over = sizes.findIndex((size) => size > AGENT_SESSION_ATTACHMENT_MAX_BYTES)
  if (over !== -1) {
    throw refused(
      `${basename(paths[over]!)} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`
    )
  }
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total > AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES) {
    throw refused(
      `These images add up to ${Math.ceil(total / MB)} MB. ${labels.singular} takes up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES / MB} MB.`
    )
  }
}

/** Validates committed store image paths under chat count, per-file, total-byte, and symlink rules. */
export async function admitStoredAttachmentImages(
  store: BotAttachmentStore,
  paths: readonly string[],
  labels: BotAttachmentImageLabels,
  refused: BotAttachmentErrorFactory
): Promise<BotAttachmentImage[]> {
  if (paths.length > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
    throw refused(`${labels.plural} take up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT} images.`)
  }
  const root = paths.length > 0 ? await realpath(store.rootDir).catch(() => null) : null
  const images: BotAttachmentImage[] = []
  let total = 0
  for (const path of paths) {
    const stored = parseAgentSessionAttachmentStorePath(store.rootDir, path)
    if (!stored || !root || !isAgentInlineImagePath(stored.name)) {
      throw refused(`Only pasted or attached images can go ${labels.surface}.`)
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
      `These images add up to ${Math.ceil(total / MB)} MB. ${labels.singular} takes up to ${AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES / MB} MB.`
    )
  }
  return images
}

/** Claims every store upload referenced by `body` for each owning session; throws via `refused`. */
export async function claimAttachmentBody(
  claim: AgentSessionAttachmentClaimer,
  sessionIds: readonly string[],
  body: AgentJournalMessageItem,
  options: {
    logPrefix: string
    retryMessage: string
    refused: BotAttachmentErrorFactory
  }
): Promise<void> {
  try {
    for (const sessionId of new Set(sessionIds)) {
      await claim(sessionId, body)
    }
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      const names = error.expired.map(({ name }) => name).join(', ')
      throw options.refused(`${names}: this attachment expired. Attach it again.`)
    }
    console.warn(options.logPrefix, error)
    throw options.refused(options.retryMessage)
  }
}
