import { z } from 'zod'
import type { CardNote } from './connector-adapter.js'
import type { PostBody } from './connector-posts.js'
import type { AnswerablePrompt } from './owner-controls.js'
import { MAX_BUTTON_LABEL_CHARS, slackText } from './slack-text.js'

// Slack's limit on buttons per actions block.
const MAX_BUTTONS = 25

const CardBodySchema = z.object({
  blocks: z.array(z.looseObject({ type: z.string() })).optional()
})

// A prompt card as Block Kit, when all its options fit on buttons; null leaves it to Orca.
export function slackCard(prompt: AnswerablePrompt): PostBody | null {
  const text = slackText.promptCard(prompt)
  const fits =
    prompt.options.length > 0 &&
    prompt.options.length <= MAX_BUTTONS &&
    prompt.options.every((option) => option.label.trim().length > 0) &&
    text.length > 0
  return fits
    ? {
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          {
            type: 'actions',
            elements: prompt.options.map((option, index) => ({
              type: 'button',
              action_id: `answer:${index}`,
              text: { type: 'plain_text', text: option.label.slice(0, MAX_BUTTON_LABEL_CHARS) },
              value: option.id
            }))
          }
        ]
      }
    : null
}

// What the card asked, with its buttons replaced by a closing note.
export function settledSlackCard(body: unknown, note: CardNote): PostBody {
  const text =
    note.kind === 'answered'
      ? slackText.promptAnswered(note.ownerUserId, note.label)
      : slackText.promptClosed
  const asked = CardBodySchema.safeParse(body).data?.blocks?.[0]
  return {
    text,
    blocks: [...(asked ? [asked] : []), { type: 'context', elements: [{ type: 'mrkdwn', text }] }]
  }
}

// A card still showing its buttons; an answered or closed one is final.
export function isOpenSlackCard(body: unknown): boolean {
  return (
    CardBodySchema.safeParse(body).data?.blocks?.some((block) => block.type === 'actions') ?? false
  )
}
