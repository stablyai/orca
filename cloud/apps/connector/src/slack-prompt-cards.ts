import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import type { ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import { z } from 'zod'
import { answerablePrompt, type AnswerablePrompt } from './owner-controls.js'
import type { SlackBlock, SlackPlace, SlackPosts } from './slack-posts.js'
import { MAX_BUTTON_LABEL_CHARS, slackText } from './slack-text.js'

// Slack's limit on buttons per actions block.
const MAX_BUTTONS = 25

const CardBodySchema = z.object({
  blocks: z.array(z.looseObject({ type: z.string() })).optional()
})

export const promptCardId = (externalId: string, promptId: string) =>
  `prompt:${externalId}:${promptId}`

// An answerable prompt whose options all fit on buttons; anything else is answered in Orca.
export function slackAnswerablePrompt(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): AnswerablePrompt | null {
  const prompt = answerablePrompt(thread, hello)
  const fits =
    prompt !== null &&
    prompt.options.length > 0 &&
    prompt.options.length <= MAX_BUTTONS &&
    prompt.options.every((option) => option.label.trim().length > 0) &&
    slackText.promptCard(prompt).length > 0
  return fits ? prompt : null
}

function openCard(prompt: AnswerablePrompt): { text: string; blocks: SlackBlock[] } {
  const text = slackText.promptCard(prompt)
  return {
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
}

// What the card asked, with its buttons replaced by a closing note.
export function settledCard(body: unknown, note: string): { text: string; blocks: SlackBlock[] } {
  const asked = CardBodySchema.safeParse(body).data?.blocks?.[0]
  return {
    text: note,
    blocks: [
      ...(asked ? [asked] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: note }] }
    ]
  }
}

// A card still showing its buttons; an answered or closed one is final.
export function isOpenCard(body: unknown): boolean {
  return (
    CardBodySchema.safeParse(body).data?.blocks?.some((block) => block.type === 'actions') ?? false
  )
}

// The conversation's prompt cards as a projection, beside its status and under the same lock: the
// shown prompt gets a card once; any other open card closes. A final card is never reopened. True
// when the shown prompt's card offers its buttons.
export async function refreshPromptCards(
  transaction: CloudDatabase,
  posts: SlackPosts,
  thread: SlackPlace & { externalId: string },
  prompt: AnswerablePrompt | null
): Promise<boolean> {
  const cards = await transaction.query(
    `SELECT post_id, body FROM connector_slack_posts WHERE kind = 'status' AND post_id LIKE ?`,
    [`${promptCardId(thread.externalId, '')}%`]
  )
  const shownId = prompt ? promptCardId(thread.externalId, prompt.promptId) : null
  const shown = cards.find((card) => card.post_id === shownId)
  if (prompt && shownId && !shown) {
    await posts.setStatus(transaction, { ...thread, postId: shownId, ...openCard(prompt) })
  }
  for (const card of cards) {
    const body: unknown = JSON.parse(String(card.body))
    if (card.post_id !== shownId && isOpenCard(body)) {
      await posts.setStatus(transaction, {
        ...thread,
        postId: String(card.post_id),
        ...settledCard(body, slackText.promptClosed)
      })
    }
  }
  return prompt !== null && (!shown || isOpenCard(JSON.parse(String(shown.body))))
}
