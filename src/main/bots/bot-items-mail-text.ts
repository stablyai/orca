// What item mail tells the bot (Orca's voice, workflow only). The owner's and other chats' words are
// fenced, so a comment can't pose as Orca's instructions; each mail names its event for `show --after`.
import { fenceQuotedText, inlineUntrusted } from '../../shared/quoted-text-fence'
import {
  botItemCommentImages,
  botItemCommentSkills,
  botItemEventId,
  type BotItemCommentImage,
  type BotItemCommentSkill,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import { offsetSentImagePromptMarkers } from '../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { statusOf } from './bot-items-rows'
import type { BotItemEventRecord, BotItemRecord } from './bot-items-schema'

const STATUS_WORDS: Record<BotItemStatus, string> = {
  planned: 'Planned',
  working: 'In progress',
  needs_you: 'Needs you',
  done: 'Done',
  canceled: 'Canceled'
}

function itemName(item: Pick<BotItemRecord, 'number' | 'title'>): string {
  return `item ${item.number} "${inlineUntrusted(item.title)}"`
}

function isClosed(status: BotItemStatus): boolean {
  return status === 'done' || status === 'canceled'
}

function statusWords(from: BotItemStatus, to: BotItemStatus): string {
  if (to === 'done') {
    return 'marked it Done'
  }
  if (to === 'canceled') {
    return 'canceled it'
  }
  return isClosed(from) ? `reopened it as ${STATUS_WORDS[to]}` : `moved it to ${STATUS_WORDS[to]}`
}

type Change = { event: BotItemEventRecord; item: BotItemRecord }

/** The one mail a write sends the chat whose items it changed, when that chat didn't make it; null when
 *  nothing in it is worth a mail. */
export function botItemChangeMail(
  changes: readonly Change[]
): { subject: string; body: string } | null {
  const actor = changes[0]?.event.actor
  const who =
    actor?.kind === 'owner'
      ? 'Your owner'
      : actor?.kind === 'bot'
        ? actor.botId === changes[0]?.item.ownerBotId
          ? 'Your other chat'
          : 'Another agent'
        : null
  const lines = changes.flatMap((change) => {
    const what = changeWords(change.event)
    return what ? [{ ...change, what }] : []
  })
  const first = lines[0]
  if (!who || !first) {
    return null
  }
  const items = new Map(lines.map(({ item }) => [item.uid, item]))
  const named = items.size === 1 ? itemName(first.item) : `${items.size} items`
  // The mail carries every comment's images in order, so each comment's [Image #N] counts past the last's.
  let imagesBefore = 0
  const body = lines.map(({ event, item, what }) => {
    const said = event.kind === 'commented' ? commentWords(event, imagesBefore) : ''
    imagesBefore += event.kind === 'commented' ? botItemCommentImages(event.data).length : 0
    return `- ${itemName(item)}: ${what} (event ${botItemEventId(event.id)})${said}`
  })
  const commentedOn = (answers: boolean) =>
    new Set(
      lines.flatMap(({ event, item }) =>
        event.kind === 'commented' && isAnswer(event) === answers ? [item.uid] : []
      )
    )
  const repliedOn = commentedOn(false)
  const answeredOn = commentedOn(true)
  // The owner's answer or other comment on a Needs you item moves it to In progress with it.
  const movedWith = (on: Set<string>, event: BotItemEventRecord, item: BotItemRecord) =>
    actor?.kind === 'owner' &&
    on.has(item.uid) &&
    event.kind === 'status' &&
    statusOf(event.data.from) === 'needs_you' &&
    statusOf(event.data.to) === 'working'
  const movedByReply = (event: BotItemEventRecord, item: BotItemRecord) =>
    movedWith(repliedOn, event, item) || movedWith(answeredOn, event, item)
  const replied = lines.some(({ event, item }) => movedWith(repliedOn, event, item))
  const tos = lines.flatMap(({ event, item }) =>
    event.kind === 'status' && !movedByReply(event, item) ? [statusOf(event.data.to)] : []
  )
  const answered = lines.some(({ event }) => isAnswer(event))
  const next = [
    answered
      ? "Your owner answered your question, and the item is In progress again: carry on with that answer. If your question still stands, set it to Needs you again with only what's left."
      : null,
    replied
      ? "Your owner replied to your question, so the item moved to In progress. If your question still stands, set it to Needs you again with only what's left."
      : null,
    tos.some(isClosed)
      ? 'If something linked to a closed item is still running, stop or redirect it.'
      : null,
    tos.some((to) => !isClosed(to)) ? 'Pick a moved item up from there.' : null
  ].filter((line) => line !== null)
  const subjectWhat = lines.length === 1 ? first.what : items.size === 1 ? 'updated' : 'changed'
  return {
    subject: `${who} ${subjectWhat} (${named})`,
    body: [
      `${who} changed ${named}:`,
      ...body,
      '',
      ...(next.length > 0 ? [next.join(' '), ''] : []),
      `Check with \`orca bot item show <n>\` before acting: items may have changed since, and mail can repeat after a crash. If nothing needs doing, end the turn without a chat reply.`
    ].join('\n')
  }
}

/** The comment fenced, then its images by number and host path: the chat shows them with this mail,
 *  and the paths stay for a mail that arrives as a pointer or to an agent without image input. */
function commentWords(event: BotItemEventRecord, imagesBefore: number): string {
  const images = botItemCommentImages(event.data)
  const text = offsetSentImagePromptMarkers(str(event.data.text) ?? '', images.length, imagesBefore)
  const said = text.trim() || images.length === 0 ? `:\n${fenceQuotedText(text)}` : ''
  return `${said}${imagesNote(images, imagesBefore)}${skillsNote(botItemCommentSkills(event.data))}`
}

const quoted = (text: string): string => text.replaceAll('"', '\\"')

/** Skills picked in the comment, as chat sends a picked skill: by the file its agent loads. */
function skillsNote(skills: readonly BotItemCommentSkill[]): string {
  if (skills.length === 0) {
    return ''
  }
  const named = skills
    // By name alone: the comment's token is `/name` or `$name` by the bot's agent.
    .map(({ name, path }) => `${inlineUntrusted(name)} "${quoted(inlineUntrusted(path, 4096))}"`)
    .join(', ')
  const which = skills.length === 1 ? 'a skill' : `${skills.length} skills`
  return `\n  [Orca: they picked ${which} for this; load each from its file and follow it: ${named}]`
}

/** `sent`: the images go with the mail as image-refs; otherwise only their paths do. */
function imagesNote(images: readonly BotItemCommentImage[], imagesBefore = 0, sent = true): string {
  if (images.length === 0) {
    return ''
  }
  const paths = images
    .map(
      ({ path }, index) => `[Image #${imagesBefore + index + 1}] "${inlineUntrusted(path, 4096)}"`
    )
    .join(', ')
  const count = images.length === 1 ? 'an image' : `${images.length} images`
  const them = images.length === 1 ? 'it' : 'them'
  const see = sent ? `, sent with this message. If you can't see ${them}, open` : `; open ${them}`
  return `\n  [Orca: they attached ${count}${see} with your image tool: ${paths}]`
}

/** Every image the owner's comments in this mail attached, oldest first. */
export function botItemMailImages(changes: readonly { event: BotItemEventRecord }[]): string[] {
  return changes.flatMap(({ event }) =>
    event.kind === 'commented' ? botItemCommentImages(event.data).map(({ path }) => path) : []
  )
}

function changeWords(event: BotItemEventRecord): string | null {
  switch (event.kind) {
    case 'commented':
      return isAnswer(event) ? `answered your question ${str(event.data.answers)}` : 'commented'
    case 'status': {
      const note = str(event.data.note)
      const words = statusWords(statusOf(event.data.from), statusOf(event.data.to))
      return `${words}${note ? `: "${inlineUntrusted(note, 400)}"` : ''}`
    }
    case 'edited':
      return 'edited it'
    case 'linked':
      return 'linked to it'
    default:
      return null
  }
}

/** The request mail an item made for another bot, or another chat, carries; the item is made once
 *  it lands, under this uid. */
export function botItemRequestMail(item: {
  uid: string
  title: string
  doneMeans: string | null
}): { subject: string; body: string } {
  const doneMeans = item.doneMeans ? `\nDone means: ${inlineUntrusted(item.doneMeans, 400)}` : ''
  return {
    subject: `New item: ${inlineUntrusted(item.title)}`,
    body: `An item was added for you: "${inlineUntrusted(item.title)}".${doneMeans}\nRead it with \`orca bot item show ${item.uid}\`, then do it and keep the item current. If show says it was never made, add it yourself if it is still wanted.`
  }
}

/** The owner's comment naming the question it replies to: written while the bot asked. */
function isAnswer(event: BotItemEventRecord): boolean {
  return event.kind === 'commented' && typeof event.data.answers === 'string'
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The bot request a comment from the bot that made an item for another bot travels as, to the
 *  item's chat. */
export function botItemMakerCommentMail(
  item: Pick<BotItemRecord, 'number' | 'title'>,
  makerName: string,
  commentText: string,
  images: readonly BotItemCommentImage[] = []
): { subject: string; body: string } {
  return {
    subject: `${makerName} commented (${itemName(item)})`,
    body: `${makerName}, which added ${itemName(item)} for you, commented on it:\n${fenceQuotedText(commentText)}${imagesNote(images, 0, false)}\n\nCheck with \`orca bot item show ${item.number}\` before acting. If nothing needs doing, end the turn without a chat reply.`
  }
}
