// A comment's attachments, the owner's or its bot's, admitted on the bot's host as chat admits its own:
// images are committed inline-image files in this host's chat attachment store, under chat's limits;
// files ride in the text as `@path`. Every store upload the comment names is claimed for the item's chat
// before the event is written, so the chat's claims and sweep keep it exactly as long as that chat's own pastes.
import { botFailure, botFailureEnglish, type BotFailure } from '../../shared/bots/bot-failure-copy'
import { isAbsolute } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentInlineImagePath } from '../../shared/native-chat/input/composer/agent-inline-image-types'
import { formatNativeChatFileReference } from '../../shared/native-chat/input/composer/agent-image-paste'
import {
  BOT_ITEM_COMMENT_FILE_MAX_COUNT,
  type BotItemCommentImage
} from '../../shared/bots/bot-items'
import { agentSessionAttachmentReferences } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { AgentSessionAttachmentClaimer } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  admitStoredAttachmentImages,
  assertLocalImagesFit,
  claimAttachmentBody,
  copyLocalAttachmentToStore,
  hasAttachmentStoreReference,
  type BotAttachmentStore
} from './bot-attachment-images'
import { BotItemError } from './bot-item-error'
import { botItemCommentAttachmentBody } from './bot-item-comment-attachment-body'

const COMMENT_IMAGE_LABELS = {
  tooMany: 'commentImagesTooMany',
  tooLarge: 'commentImagesTooLarge',
  notStored: 'commentImageNotStored'
} as const

export type BotItemCommentAttachmentDeps = {
  store: BotAttachmentStore | null
  /** This host's own window commented: an image it dropped from disk is copied into the store, as
   *  the store holds every comment image. A paired client names store paths only. */
  local: boolean
  claim: AgentSessionAttachmentClaimer | null
  /** The item's chat's live session and title; null when that chat is gone. */
  chat: () => Promise<{ sessionId: string; title: string | null } | null>
}

export type BotItemCommentAttached = { text: string; images: BotItemCommentImage[] }

/** The comment's text and images, named and sized on this host, once each upload it names is claimed
 *  for the item's chat; a text-only comment naming no upload touches nothing. `files`: files on this
 *  host's disk (a bot's `--file`), copied in: images join `paths`, other files join the text as `@path`. */
export async function admitBotItemCommentAttachments(
  deps: BotItemCommentAttachmentDeps,
  commentText: string,
  paths: readonly string[],
  files: readonly string[] = []
): Promise<BotItemCommentAttached> {
  const { store } = deps
  if (!store) {
    // Unclaimed bytes would be swept under the comment, so anything naming an upload waits for the store.
    if (paths.length > 0 || files.length > 0 || hasAttachmentStoreReference(commentText)) {
      throw refused(botFailure('commentAttachmentsUnavailable'))
    }
    return { text: commentText, images: [] }
  }
  const relative = files.find((path) => !isAbsolute(path))
  if (relative !== undefined) {
    throw refused(botFailure('commentFileNotAbsolute', { path: relative }))
  }
  const others = files.filter((path) => !isAgentInlineImagePath(path))
  if (others.length > BOT_ITEM_COMMENT_FILE_MAX_COUNT) {
    throw refused(botFailure('commentFilesTooMany', { max: BOT_ITEM_COMMENT_FILE_MAX_COUNT }))
  }
  const local = deps.local ? [...paths, ...files.filter(isAgentInlineImagePath)] : paths
  if (deps.local) {
    await assertLocalImagesFit(store, local, COMMENT_IMAGE_LABELS, refused)
  }
  const [stored, storedFiles] = await Promise.all([
    deps.local
      ? Promise.all(local.map((path) => copyLocalAttachmentToStore(store, path, refused)))
      : local,
    Promise.all(others.map((path) => copyLocalAttachmentToStore(store, path, refused, true)))
  ])
  const images = await admitStoredAttachmentImages(store, stored, COMMENT_IMAGE_LABELS, refused)
  const references = storedFiles.map(formatNativeChatFileReference).join('\n')
  const text = !references
    ? commentText
    : commentText.trim()
      ? `${commentText.trimEnd()}\n\n${references}`
      : references
  const body = botItemCommentAttachmentBody(text, images)
  if (agentSessionAttachmentReferences(store.rootDir, body).size === 0) {
    return { text, images }
  }
  const chat = await deps.chat()
  if (!chat) {
    throw refused(botFailure('commentChatDeleted'))
  }
  await claimBotItemCommentAttachments(deps.claim, chat.sessionId, body)
  return { text, images }
}

async function claimBotItemCommentAttachments(
  claim: AgentSessionAttachmentClaimer | null,
  sessionId: string,
  body: AgentJournalMessageItem
): Promise<void> {
  if (!claim) {
    throw refused(botFailure('commentAttachFailed'))
  }
  await claimAttachmentBody(claim, [sessionId], body, {
    logPrefix: '[bots] items: claiming comment attachments failed',
    retry: botFailure('commentAttachFailed'),
    refused
  })
}

function refused(failure: BotFailure): BotItemError {
  return new BotItemError('invalid_argument', botFailureEnglish(failure), { botFailure: failure })
}
