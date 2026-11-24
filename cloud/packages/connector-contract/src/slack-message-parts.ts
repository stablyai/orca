import { z } from 'zod'
import { formatConnectorRef } from './action-messages.js'
import {
  MESSAGE_PART_LIMITS,
  type ConnectorLinkPreview,
  type ConnectorMessageFile,
  type ConnectorMessageParts,
  type ConnectorSharedMessage
} from './message-parts.js'

// A Slack message's words and what it holds beyond them, as Slack's Web API and events send it: files,
// messages shared (forwarded) into it or previewed from a link to one, and other link previews.

const SLACK_TS = /^\d{1,12}\.\d{1,8}$/
const SLACK_ID = /^[A-Z0-9]{1,32}$/
const SLACK_MESSAGE_LINK = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[\w.=&%-]*)?$/
const WEB_LINK = /^https?:\/\/\S+$/

const FileSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  mimetype: z.string().nullish(),
  size: z.number().nullish()
})
const BlocksSchema = z.array(z.unknown()).nullish()
const InnerMessageSchema = z.looseObject({
  text: z.string().nullish(),
  blocks: BlocksSchema,
  files: z.array(FileSchema).nullish()
})
const AttachmentSchema = z.looseObject({
  is_share: z.boolean().nullish(),
  is_msg_unfurl: z.boolean().nullish(),
  author_name: z.string().nullish(),
  author_subname: z.string().nullish(),
  channel_id: z.string().nullish(),
  channel_team: z.string().nullish(),
  ts: z.string().nullish(),
  thread_ts: z.string().nullish(),
  from_url: z.string().nullish(),
  original_url: z.string().nullish(),
  title: z.string().nullish(),
  title_link: z.string().nullish(),
  text: z.string().nullish(),
  fallback: z.string().nullish(),
  blocks: BlocksSchema,
  files: z.array(FileSchema).nullish(),
  message_blocks: z
    .array(z.looseObject({ message: InnerMessageSchema.nullish() }))
    .nullish()
})
const MessageSchema = z.looseObject({
  text: z.string().nullish(),
  blocks: BlocksSchema,
  files: z.array(FileSchema).nullish(),
  attachments: z.array(z.unknown()).nullish()
})

// Rich text's words: sections, lists, quotes and code, with links, mentions and emoji as Slack writes
// them in text.
const RichElement = z.looseObject({
  type: z.string(),
  text: z.string().nullish(),
  url: z.string().nullish(),
  user_id: z.string().nullish(),
  channel_id: z.string().nullish(),
  usergroup_id: z.string().nullish(),
  name: z.string().nullish(),
  range: z.string().nullish(),
  elements: z.array(z.unknown()).nullish()
})

function richText(node: unknown): string {
  const element = RichElement.safeParse(node)
  if (!element.success) {
    return ''
  }
  const { type, text, url, elements } = element.data
  switch (type) {
    case 'text':
      return text ?? ''
    case 'link':
      return text && url ? `<${url}|${text}>` : (url ?? text ?? '')
    case 'user':
      return element.data.user_id ? `<@${element.data.user_id}>` : ''
    case 'channel':
      return element.data.channel_id ? `<#${element.data.channel_id}>` : ''
    case 'usergroup':
      return element.data.usergroup_id ? `<!subteam^${element.data.usergroup_id}>` : ''
    case 'broadcast':
      return element.data.range ? `<!${element.data.range}>` : ''
    case 'emoji':
      return element.data.name ? `:${element.data.name}:` : ''
    case 'rich_text_list':
      return (elements ?? []).map((item) => `• ${richText(item)}`).join('\n')
    case 'rich_text_quote':
      return richText({ type: 'rich_text_section', elements })
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'rich_text_preformatted':
      return `\`\`\`\n${richText({ type: 'rich_text_section', elements })}\n\`\`\``
    case 'rich_text':
      return (elements ?? []).map(richText).join('\n')
    default:
      return (elements ?? []).map(richText).join('')
  }
}

/** The words of rich_text blocks; other blocks have their own fallback text in the message. */
export function slackBlocksText(blocks: readonly unknown[] | null | undefined): string {
  return (blocks ?? [])
    .flatMap((block) => (RichElement.safeParse(block).data?.type === 'rich_text' ? [richText(block)] : []))
    .join('\n')
    .trim()
}

// Slack writes &, < and > escaped in text, not in blocks.
const unescaped = (text: string) =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

/** A message's words: its text, or its blocks' words where they say more than the text does. */
export function slackMessageText(message: { text?: string | null; blocks?: readonly unknown[] | null }): string {
  const text = message.text ?? ''
  const blocks = slackBlocksText(message.blocks)
  const plain = unescaped(text).trim()
  return blocks.length > plain.length && blocks.startsWith(plain) ? blocks : text
}

const fileOf = (file: z.infer<typeof FileSchema>): ConnectorMessageFile | null =>
  // A file Slack hides (past a plan's limit, or deleted) has no name, and nothing to open.
  file.name
    ? {
        id: file.id,
        name: file.name.slice(0, 1024),
        ...(file.mimetype ? { type: file.mimetype } : {}),
        ...(typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0
          ? { size: file.size }
          : {})
      }
    : null

const threadOfLink = (link: string | null | undefined): string | undefined => {
  try {
    const thread = link ? new URL(link).searchParams.get('thread_ts') : null
    return thread && SLACK_TS.test(thread) ? thread : undefined
  } catch {
    return undefined
  }
}

function sharedOf(
  attachment: z.infer<typeof AttachmentSchema>,
  workspaceId: string
): { shared: ConnectorSharedMessage; files: ConnectorMessageFile[] } {
  const inner = (attachment.message_blocks ?? []).flatMap((block) => (block.message ? [block.message] : []))
  const words =
    slackMessageText(attachment) ||
    inner.map((message) => slackMessageText(message)).join('\n') ||
    attachment.fallback ||
    ''
  const files = [...(attachment.files ?? []), ...inner.flatMap((message) => message.files ?? [])].flatMap(
    (file) => fileOf(file) ?? []
  )
  const { channel_id: channel, ts } = attachment
  const team = attachment.channel_team ?? workspaceId
  const ref =
    channel && ts && SLACK_ID.test(channel) && SLACK_ID.test(team) && SLACK_TS.test(ts)
      ? formatConnectorRef({
          source: 'slack',
          workspaceId: team,
          containerId: channel,
          threadId:
            threadOfLink(attachment.from_url) ??
            (attachment.thread_ts && SLACK_TS.test(attachment.thread_ts) ? attachment.thread_ts : ts),
          messageId: ts
        })
      : undefined
  const author = attachment.author_name ?? attachment.author_subname
  const url = attachment.from_url
  return {
    shared: {
      ...(author ? { author: author.slice(0, 200) } : {}),
      ...(ref && ref.length <= MESSAGE_PART_LIMITS.maxRef ? { ref } : {}),
      ...(url && url.length <= MESSAGE_PART_LIMITS.maxSharedUrl && SLACK_MESSAGE_LINK.test(url) ? { url } : {}),
      ...(ts && SLACK_TS.test(ts) ? { at: Math.floor(Number(ts) * 1000) } : {}),
      text: words.slice(0, MESSAGE_PART_LIMITS.maxSharedText),
      ...(words.length > MESSAGE_PART_LIMITS.maxSharedText ? { cut: true as const } : {})
    },
    files
  }
}

function linkOf(attachment: z.infer<typeof AttachmentSchema>): ConnectorLinkPreview | null {
  const url = attachment.title_link ?? attachment.original_url ?? attachment.from_url
  if (!url || url.length > MESSAGE_PART_LIMITS.maxLinkUrl || !WEB_LINK.test(url)) {
    return null
  }
  const text = attachment.text || slackBlocksText(attachment.blocks) || attachment.fallback
  return {
    url,
    ...(attachment.title ? { title: attachment.title.slice(0, MESSAGE_PART_LIMITS.maxLinkTitle) } : {}),
    ...(text ? { text: text.slice(0, MESSAGE_PART_LIMITS.maxLinkText) } : {})
  }
}

/** A Slack message's parts within MESSAGE_PART_LIMITS, counting what is past them in partsLeftOut.
 *  workspaceId is the team the message is in, for a shared message that doesn't name its own. */
export function slackMessageParts(raw: unknown, workspaceId: string): ConnectorMessageParts {
  const message = MessageSchema.safeParse(raw).data
  if (!message) {
    return {}
  }
  let left = 0
  const keep = <T>(items: T[], max: number): T[] => {
    left += Math.max(0, items.length - max)
    return items.slice(0, max)
  }
  const attachments = (message.attachments ?? []).flatMap((item) => {
    const attachment = AttachmentSchema.safeParse(item)
    return attachment.success ? [attachment.data] : []
  })
  const isShared = (attachment: z.infer<typeof AttachmentSchema>) =>
    attachment.is_share === true ||
    (attachment.is_msg_unfurl === true && Boolean(attachment.channel_id) && Boolean(attachment.ts))
  const allShares = attachments.filter(isShared).map((attachment) => sharedOf(attachment, workspaceId))
  // A share past the limit is left out with its files.
  left += allShares.slice(MESSAGE_PART_LIMITS.maxShared).reduce((sum, share) => sum + share.files.length, 0)
  const shares = keep(allShares, MESSAGE_PART_LIMITS.maxShared)
  const links = keep(
    attachments.filter((attachment) => !isShared(attachment)).flatMap((attachment) => linkOf(attachment) ?? []),
    MESSAGE_PART_LIMITS.maxLinks
  )
  // Files share one limit, the message's own first, then each shared message's in turn.
  let room = MESSAGE_PART_LIMITS.maxFiles
  const take = (files: ConnectorMessageFile[]) => {
    const kept = files.slice(0, room)
    room -= kept.length
    left += files.length - kept.length
    return kept
  }
  const files = take((message.files ?? []).flatMap((file) => fileOf(file) ?? []))
  const shared = shares.map(({ shared: item, files: inner }) => {
    const kept = take(inner)
    return kept.length > 0 ? { ...item, files: kept } : item
  })
  return {
    ...(files.length > 0 ? { files } : {}),
    ...(shared.length > 0 ? { shared } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(left > 0 ? { partsLeftOut: left } : {})
  }
}
