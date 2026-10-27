import { z } from 'zod'
import type { CardNote } from './connector-adapter.js'
import type { PostBody } from './connector-posts.js'
import { discordText, MAX_DISCORD_CONTENT_CHARS, MAX_DISCORD_LABEL_CHARS } from './discord-text.js'
import type { AnswerablePrompt } from './owner-controls.js'

// https://docs.discord.com/developers/components/reference: five buttons per action row, five
// rows, and a custom_id of at most 100 characters.
const BUTTONS_PER_ROW = 5
const MAX_BUTTONS = 25
const MAX_CUSTOM_ID_CHARS = 100
const ACTION_ROW = 1
const BUTTON = 2
const SECONDARY = 2
export const ANSWER_PREFIX = 'answer:'

const CardBodySchema = z.object({
  content: z.string(),
  components: z.array(z.unknown()).optional()
})

// A prompt card with one button per option, the option id in its custom_id; null leaves it to Orca.
export function discordCard(prompt: AnswerablePrompt): PostBody | null {
  const content = discordText.promptCard(prompt)
  const fits =
    prompt.options.length > 0 &&
    prompt.options.length <= MAX_BUTTONS &&
    prompt.options.every(
      (option) =>
        option.label.trim().length > 0 &&
        ANSWER_PREFIX.length + option.id.length <= MAX_CUSTOM_ID_CHARS
    ) &&
    content.length > 0
  if (!fits) {
    return null
  }
  const buttons = prompt.options.map((option) => ({
    type: BUTTON,
    style: SECONDARY,
    custom_id: `${ANSWER_PREFIX}${option.id}`,
    label: option.label.slice(0, MAX_DISCORD_LABEL_CHARS)
  }))
  const rows = []
  for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) {
    rows.push({ type: ACTION_ROW, components: buttons.slice(start, start + BUTTONS_PER_ROW) })
  }
  return { content, components: rows }
}

// What the card asked, its buttons replaced by a closing note.
export function settledDiscordCard(body: unknown, note: CardNote): PostBody {
  const text =
    note.kind === 'answered'
      ? discordText.promptAnswered(note.ownerUserId, note.label)
      : discordText.promptClosed
  const closing = `-# ${text}`
  // The note takes its room from what was asked, so the edit stays within Discord's limit.
  const asked = CardBodySchema.safeParse(body).data?.content.slice(
    0,
    MAX_DISCORD_CONTENT_CHARS - closing.length - 1
  )
  return { content: asked ? `${asked}\n${closing}` : closing, components: [] }
}

// A card still showing its buttons; an answered or closed one is final.
export function isOpenDiscordCard(body: unknown): boolean {
  return (CardBodySchema.safeParse(body).data?.components?.length ?? 0) > 0
}
