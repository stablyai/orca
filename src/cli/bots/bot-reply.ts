import { randomUUID } from 'node:crypto'
import { ORCA_SCRUB_SAFE_PANE_ENV } from '../../shared/agent-hook-listener/transport/agent-hook-scrub-safe-env'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  CONNECTOR_REPLY_MAX_FILES,
  type ConnectorActionArgs
} from '../../shared/connector-action-contract'
import { CONNECTOR_REPLY_UNAVAILABLE } from '../../shared/rpc-contract/connectors/connector-params'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { readReplyNotes } from './bot-reply-notes'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  localFile,
  newPostId,
  uploadArgs,
  uploadFile,
  type LocalFile
} from '../slack/slack-action-files'
import { readMessageText } from '../slack/slack-action-args'
import type { ActionResult } from '../slack/slack-action-format'

// The host retries an unavailable cloud itself, waiting out Retry-After, so the call can take a while.
const REPLY_TIMEOUT_MS = 180_000

// notices: why the reply can't wake an Orca bot it mentions.
type ConnectorReply = { status: 'posted' | 'queued'; place?: string; notices?: string[] }

// A host that can't post for anyone: connectors off or signed out.
const REPLY_UNAVAILABLE_CODES = new Set(['connector_not_connected', 'connectors_disabled'])

// Each says what was true and what to do instead; a Home chat or automation run is the common case.
const REPLY_REFUSALS: Readonly<Record<string, string>> = {
  not_a_cloud_conversation:
    "Nothing was posted: this chat isn't attached to a Slack, GitHub, Linear or Discord thread on this host. A reply works only in a conversation someone started by messaging the bot there, or an event's run that answers in its thread. Your Home chat has none, and an automation run has one only when its results go to the event's thread (--results-to thread); put it in your final message, which goes wherever this chat's results go.",
  bot_chat_reply:
    'Nothing was posted: this is your Chat, which has no one conversation to post into. Your final message is posted when you finish.',
  not_this_bots_conversation:
    "Nothing was posted: this chat's conversation doesn't belong to this bot."
}

export function formatReply(reply: ConnectorReply): string {
  const place = reply.place ?? 'the thread'
  return [
    reply.status === 'posted'
      ? `Posted to ${place}.`
      : `Sent; Orca Cloud will post it to ${place}.`,
    ...(reply.notices ?? [])
  ].join('\n')
}

function formatAttached(attached: NonNullable<BotReplyResult['attached']>): string {
  const one = attached.files === 1
  const what = one
    ? 'The file'
    : attached.posts > 1
      ? `${attached.files} files, one message each,`
      : `${attached.files} files`
  const place = attached.place ?? attached.target?.label ?? 'the thread'
  const queued = `${what} went to Orca Cloud, which posts ${one ? 'it' : 'them'} to ${place} shortly.`
  const status = !attached.queued
    ? `${what} posted to ${place}.`
    : attached.unconfirmed
      ? `${queued} Orca couldn't confirm they posted; read the thread before sending them again.`
      : queued
  return [status, ...(attached.notices ?? [])].join('\n')
}

type ReplyCaller = { paneKey: string } | { sessionId: string }

function replyCaller(): ReplyCaller {
  // Claude can scrub names containing KEY from its tools' environment; the alias survives.
  const paneKey = process.env.ORCA_PANE_KEY || process.env[ORCA_SCRUB_SAFE_PANE_ENV]
  // A native chat's agent has no pane; its session id names the chat.
  const sessionId = readInjectedAgentSessionId()
  if (paneKey) {
    return { paneKey }
  }
  if (sessionId) {
    return { sessionId }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Run this from an agent a Slack, GitHub or Linear message woke; this is not an Orca agent pane or chat.'
  )
}

function refusalOf(error: unknown): never {
  if (error instanceof RuntimeClientError && REPLY_UNAVAILABLE_CODES.has(error.code)) {
    throw new RuntimeClientError('not_a_cloud_conversation', CONNECTOR_REPLY_UNAVAILABLE)
  }
  const refusal = error instanceof RuntimeClientError && REPLY_REFUSALS[error.code]
  if (refusal) {
    throw new RuntimeClientError(error.code, refusal)
  }
  throw error
}

type BotReplyResult = {
  reacted?: string
  reply?: ConnectorReply
  attached?: ActionResult & { files: number; posts: number; place?: string; unconfirmed?: true }
}

type ActResponse =
  | { ok: true; result: ActionResult & { place?: string } }
  | { ok: false; refusal: string; message: string }

/** One `reply` act: a file's upload slot, or the files staged for it with its words. */
async function replyAct(
  client: HandlerContext['client'],
  sessionId: string,
  args: ConnectorActionArgs
): Promise<RuntimeRpcSuccess<ActionResult & { place?: string }>> {
  const answer = await client
    .call<ActResponse>(
      'connector.act',
      { sessionId, verb: 'reply', args },
      { timeoutMs: REPLY_TIMEOUT_MS }
    )
    .catch(refusalOf)
  if (!answer.result.ok) {
    throw new RuntimeClientError(answer.result.refusal, answer.result.message)
  }
  return { ...answer, result: answer.result.result }
}

const withText = (text: string | undefined) => (text ? { text } : {})
const SETTLE_CHECKS = 4
const SETTLE_CHECK_MS = 1500
// How a queued reply's posts can end; anything else asking again meets leaves it queued.
const SETTLED_REFUSALS = new Set(['post_failed', 'post_uncertain'])

/** --file: each file takes a slot in the thread that woke the run and its bytes go from disk
 *  straight to it; then one reply names them all, with --text, as one post. Each postId is minted
 *  once, so the host's retries after a lost answer stage and post each at most once. */
async function replyWithFiles(
  client: HandlerContext['client'],
  sessionId: string,
  files: readonly LocalFile[],
  text: string | undefined
): Promise<
  RuntimeRpcSuccess<ActionResult & { place?: string; posts: number; unconfirmed?: true }>
> {
  const staged: string[] = []
  for (const file of files) {
    const postId = newPostId()
    const slot = await replyAct(client, sessionId, { ...uploadArgs(file), postId })
    if (!slot.result.upload) {
      throw new RuntimeClientError(
        'cloud_lacks_direct_files',
        "Orca Cloud didn't say where to send the file; nothing was posted. Update Orca and try again."
      )
    }
    await uploadFile(slot.result.upload.url, file)
    staged.push(postId)
  }
  const args = { files: staged, ...withText(text), postId: newPostId() }
  let posted = await replyAct(client, sessionId, args)
  // Asked again under the same postId, the cloud posts nothing more and says how its posts went,
  // so a share Slack refuses reaches the bot rather than reading as queued.
  for (let check = 0; posted.result.queued && check < SETTLE_CHECKS; check++) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_CHECK_MS))
    try {
      posted = await replyAct(client, sessionId, args)
    } catch (error) {
      if (error instanceof RuntimeClientError && SETTLED_REFUSALS.has(error.code)) {
        throw error
      }
      // The reply is queued either way; only how it went is unknown.
      return { ...posted, result: { ...posted.result, posts: 1, unconfirmed: true } }
    }
  }
  return { ...posted, result: { ...posted.result, posts: 1 } }
}

function refuseFlags(flags: HandlerContext['flags']): void {
  const has = (flag: string) =>
    getOptionalStringFlag(flags, flag) !== undefined || (flag === 'text' && flags.has('text-file'))
  const refusal = has('note')
    ? has('file')
      ? 'Send line notes and a file in two replies.'
      : !has('text')
        ? 'Line notes need --text, the review they go with.'
        : null
    : !has('text') && !has('react') && !has('file')
      ? 'Give --text, --file or --react.'
      : null
  if (refusal) {
    throw new RuntimeClientError('invalid_argument', refusal)
  }
}

export const BOT_REPLY_HANDLERS: Record<string, CommandHandler> = {
  'bot reply': async ({ flags, client, json, cwd }) => {
    refuseFlags(flags)
    const caller = replyCaller()
    const text = await readMessageText(flags, cwd, false)
    const emoji = getOptionalStringFlag(flags, 'react')
    const paths = getRepeatedStringFlag(flags, 'file')
    if (paths.length > CONNECTOR_REPLY_MAX_FILES) {
      throw new RuntimeClientError(
        'invalid_argument',
        `A reply takes up to ${CONNECTOR_REPLY_MAX_FILES} files; send the rest in another reply.`
      )
    }
    const notes = readReplyNotes(flags)
    const sessionId = readInjectedAgentSessionId()
    if ((emoji || paths.length > 0) && !sessionId) {
      throw new RuntimeClientError(
        'invalid_argument',
        "--react and --file work only in a bot's chat."
      )
    }
    // All found before anything posts, so a missing file posts nothing.
    const files = await Promise.all(paths.map((path) => localFile(cwd, path)))
    const reacted =
      emoji && sessionId
        ? await client
            .call<{ ok: true }>(
              'connector.react',
              { sessionId, emoji },
              { timeoutMs: REPLY_TIMEOUT_MS }
            )
            .catch(refusalOf)
        : undefined
    // With files, --text goes with them as one post.
    const attached =
      files.length > 0 && sessionId
        ? await replyWithFiles(client, sessionId, files, text)
        : undefined
    const replied =
      text && files.length === 0
        ? await client
            .call<ConnectorReply>(
              'connector.reply',
              // Minted once here, so Orca Cloud posts it once however often the host retries.
              {
                ...caller,
                replyId: randomUUID(),
                text,
                ...(notes ? { review: notes } : {})
              },
              { timeoutMs: REPLY_TIMEOUT_MS }
            )
            .catch(refusalOf)
        : undefined
    const envelope = replied ?? attached ?? reacted
    if (!envelope) {
      return
    }
    const result: BotReplyResult = {
      ...(reacted && emoji ? { reacted: emoji } : {}),
      ...(replied ? { reply: replied.result } : {}),
      ...(attached ? { attached: { ...attached.result, files: files.length } } : {})
    }
    printResult({ ...envelope, result }, json, (value) =>
      [
        ...(value.reacted ? [`Reacted ${value.reacted}.`] : []),
        ...(value.reply ? [formatReply(value.reply)] : []),
        ...(value.attached ? [formatAttached(value.attached)] : [])
      ].join('\n')
    )
  }
}
