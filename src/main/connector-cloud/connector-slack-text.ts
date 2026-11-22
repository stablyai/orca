// What a bot's host sends toward Slack, with local paths reduced to file names (slack-local-paths.ts).
// Files, ids and every other field stay as they are; other sources get the text untouched.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import type { ConnectorReview } from '../../shared/connector-review-contract'
import { isRefOf, slackChannelIdOf } from '../../shared/connector-place-names'
import { redactLocalPaths } from '../../shared/connectors/slack-local-paths'

export const isSlackConversation = (conversation: { source: string } | null | undefined): boolean =>
  conversation?.source === 'slack'

/** A review's notes as Slack shows them; their paths are repo paths, which stay. */
export function slackReview(review: ConnectorReview): ConnectorReview {
  return {
    ...review,
    comments: review.comments.map((note) => ({
      ...note,
      path: redactLocalPaths(note.path),
      body: redactLocalPaths(note.body)
    }))
  }
}

/** A Slack action's words: its text, title and list items. */
export function slackActionArgs(args: ConnectorActionArgs): ConnectorActionArgs {
  return {
    ...args,
    ...(args.text === undefined ? {} : { text: redactLocalPaths(args.text) }),
    ...(args.title === undefined ? {} : { title: redactLocalPaths(args.title) }),
    ...(args.items === undefined
      ? {}
      : { items: args.items.map((item) => redactLocalPaths(item)) }),
    ...(args.choices === undefined
      ? {}
      : { choices: args.choices.map((choice) => redactLocalPaths(choice)) })
  }
}

/** A reply as it goes to its conversation: scrubbed, notes too, before any folding, when that is Slack. */
export function slackReplyBody<
  T extends { conversation: { source: string }; text: string; review?: ConnectorReview }
>(body: T): T {
  if (!isSlackConversation(body.conversation)) {
    return body
  }
  return {
    ...body,
    text: redactLocalPaths(body.text),
    ...(body.review ? { review: slackReview(body.review) } : {})
  }
}

/** A bot's own post: a Slack channel or `slack:` ref is scrubbed; a Linear issue or ref is not. */
export function slackBotPostBody<T extends { text: string; channelId?: string; ref?: string }>(
  body: T
): T {
  const slack =
    body.channelId !== undefined || (body.ref !== undefined && isRefOf('slack', body.ref))
  return slack ? { ...body, text: redactLocalPaths(body.text) } : body
}

// Verbs only Slack has; any other verb is Slack's only when its place is a Slack place by its form.
const SLACK_ONLY_VERBS: ReadonlySet<string> = new Set(['canvas', 'list', 'pin', 'scheduled'])

/** Whether an action's words go to Slack, from what the host knows: the woken conversation for a
 *  reply, the verb, or a ref in Slack's own forms. A bare name only the cloud resolves stays as is. */
export function actionGoesToSlack(input: {
  verb: string
  ref: string | undefined
  title: string | undefined
  conversation: { source: string } | null
}): boolean {
  if (input.verb === 'reply') {
    return isSlackConversation(input.conversation)
  }
  if (SLACK_ONLY_VERBS.has(input.verb)) {
    return true
  }
  const ref = input.ref?.trim()
  if (!ref || input.title !== undefined) {
    return false
  }
  return (
    isRefOf('slack', ref) ||
    ref.startsWith('#') ||
    ref.startsWith('@') ||
    slackChannelIdOf(ref) !== ref
  )
}
