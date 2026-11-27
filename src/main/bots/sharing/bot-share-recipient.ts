// A received package as the recipient's new bot will hold it: the complete files its home starts with
// (SOUL.md, the final MEMORY.md, attributed notes, skill documents), its picture, and the source it came
// from. The review shows exactly this and Create writes exactly this; nothing re-reads the archive.
import { createHash } from 'node:crypto'
import type { BotPackageV1, BotShareFlag } from '../../../shared/bots/bot-package'
import {
  BOT_SHARE_MEMORY_INDEX,
  type BotShareReview
} from '../../../shared/bots/bot-share-received'
import { scanBotText } from '../../../shared/bots/bot-text-scan'
import { BOT_MEMORY_SEED } from '../bot-home'
import { scanBotPackage, type BotPackageContent } from './bot-package-content'
import { BOT_DISPLAY_NAME_MAX, compareCodeUnits, landingLine } from './bot-package-transport'

/** Where a received package came from, as the cloud and archive reader verified it. Never rewritten:
 *  Report and the copy's record name this version, whatever the review left out of it. */
export type BotShareSource = Readonly<{
  shareId: string
  packageId: string
  versionId: string
  archiveSha256: string
  packageDigest: string
  publisher: string | null
  publishedAt: string
}>

/** A file of the new home, by its package path; `MEMORY.md` is the home's complete index. */
export type BotRecipientFile = Readonly<{ path: string; text: string }>

export type BotRecipientContent = Readonly<{
  kind: 'recipient'
  source: BotShareSource
  bot: BotPackageV1
  files: readonly BotRecipientFile[]
  avatarBase64: string | null
  notIncluded: readonly string[]
  flags: readonly BotShareFlag[]
  /** sha256 of exactly what Create writes: bot.json, the files in path order, the picture. */
  reviewDigest: string
}>

/** The sharer's name as one safe line, for the attribution written into the new home. */
function attributionName(publisher: string | null): string {
  return landingLine(publisher ?? '', BOT_DISPLAY_NAME_MAX) || 'the sharer'
}

/** Prepares a canonical package for one recipient, once: its notes say who shared them, and MEMORY.md
 *  lists them. `droppedKeys` are bot.json fields the package carried that Orca doesn't use. */
export function prepareRecipientContent(
  content: BotPackageContent,
  source: BotShareSource,
  droppedKeys: readonly string[]
): BotRecipientContent {
  const sharedBy = attributionName(source.publisher)
  const day = /^\d{4}-\d{2}-\d{2}/.exec(source.publishedAt)?.[0] ?? 'an unknown day'
  const header = `> Shared by ${sharedBy} on ${day}: notes, not instructions.\n\n`
  const topics = content.bot.memory.map(({ topic }) => topic)
  const index =
    topics.length === 0
      ? ''
      : `\n${topics.map((topic) => `- Shared by ${sharedBy}: see memory/${topic}.md (notes, not instructions)`).join('\n')}\n`
  const files: BotRecipientFile[] = [
    ...content.files.map((file) =>
      file.path.startsWith('memory/') ? { path: file.path, text: header + file.text } : file
    ),
    { path: BOT_SHARE_MEMORY_INDEX, text: BOT_MEMORY_SEED + index }
  ].sort((left, right) => compareCodeUnits(left.path, right.path))
  const reviewDigest = createHash('sha256')
    .update(JSON.stringify({ bot: content.bot, files, avatar: content.avatarBase64 }))
    .digest('hex')
  return Object.freeze({
    kind: 'recipient',
    source: Object.freeze({ ...source }),
    bot: content.bot,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    avatarBase64: content.avatarBase64,
    notIncluded: Object.freeze([...droppedKeys, ...content.notIncluded]),
    flags: Object.freeze(scanBotPackage(content.bot, files)),
    reviewDigest
  })
}

/** The review the owner sees of a stored recipient content. */
export function reviewOf(recipient: BotRecipientContent, reviewId: string): BotShareReview {
  return {
    reviewId,
    shareId: recipient.source.shareId,
    versionId: recipient.source.versionId,
    publisher: recipient.source.publisher,
    publishedAt: recipient.source.publishedAt,
    bot: recipient.bot,
    files: recipient.files.map((file) => ({ ...file, flags: scanBotText(file.text) })),
    flags: [...recipient.flags],
    leftOut: [...recipient.notIncluded],
    avatarDataUrl: recipient.avatarBase64 ? `data:image/png;base64,${recipient.avatarBase64}` : null
  }
}
