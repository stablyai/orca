// The Slack mirror's calls to Orca Cloud, and what of a person's message they carry.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as z from 'zod'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatTextAttachmentParts } from '../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  SlackMirrorStatus,
  SLACK_MIRROR_FEATURE,
  SLACK_MIRROR_MAX_FILES,
  SlackMirrorPostResponse,
  slackMirrorPath,
  type SlackMirrorFileBody,
  type SlackMirrorPostBody,
  type SlackMirrorTypist
} from '../../shared/connectors/connector-slack-mirror-contract'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { ConnectorTransport } from '../connector-cloud/connector-machine'
import { postWithRetries } from '../connector-cloud/connector-replies'

export type SlackMirrorCloud = ConnectorTransport & {
  cloudFeatures(): ReadonlySet<string> | null
}

/** The cloud, when it takes mirrored posts. */
export function mirroringCloud(cloud: SlackMirrorCloud | null): SlackMirrorCloud | null {
  return cloud?.cloudFeatures()?.has(SLACK_MIRROR_FEATURE) ? cloud : null
}

// Every mirror route but the post itself answers 204 with no body.
const NoContent = z.undefined()
// Bot and chat picks in Orca's own markup, `[Bot: Atlas](bot:id)`, read in Slack as their names.
const ORCA_MENTION = /\[([^\]\n]{1,200})\]\((?:bot|bot-chat):[^)\s]{1,400}\)/g

/** The text and attachment paths of a person's message, as Slack gets them. */
export function slackMirrorContent(body: AgentJournalMessageItem): {
  text: string
  paths: string[]
} {
  const paths: string[] = []
  const words: string[] = []
  for (const block of body.blocks) {
    if (block.type === 'image-ref' && block.path) {
      paths.push(block.path)
    } else if (block.type === 'text' && block.text) {
      const parts = nativeChatTextAttachmentParts(block.text, true)
      words.push(
        parts
          .map((part) => {
            if (part.path) {
              paths.push(part.path)
              return ''
            }
            return part.text
          })
          .join('')
      )
    }
  }
  return {
    text: words.join('\n').replace(ORCA_MENTION, '$1').trim(),
    paths: [...new Set(paths)]
  }
}

export type SlackMirrorCall = {
  cloud: SlackMirrorCloud
  botId: string
  signal: AbortSignal
  random: () => number
}

/** One mirror route with the replies' retries; the same ids never post twice. */
export function slackMirrorCall(
  { cloud, botId, signal, random }: SlackMirrorCall,
  route: Parameters<typeof slackMirrorPath>[1],
  body: unknown,
  schema: z.ZodType = NoContent
): Promise<ConnectorResult<unknown>> {
  return postWithRetries(
    cloud,
    { path: slackMirrorPath(botId, route), body, schema },
    signal,
    random
  )
}

/** What the cloud says of a thread; null when it couldn't say. */
export async function readSlackMirrorStatus(
  { cloud, botId, signal }: SlackMirrorCall,
  externalId: string
): Promise<SlackMirrorStatus | null> {
  const path = `${slackMirrorPath(botId, 'status')}?conversation=${encodeURIComponent(externalId)}`
  const read = await cloud.call(path, undefined, SlackMirrorStatus, { method: 'GET', signal })
  return read.ok ? read.value : null
}

/** Who typed a message, as the cloud names its post: from where the host saw it typed. One with no
 *  record of that (from before it was kept) is the host's, as the cloud reads a missing typist. A
 *  paired device goes by the account name it claimed when the message was sent (unverified, so by
 *  name only, never a Slack person); one that claimed none, the computer. */
export function slackMirrorTypist(
  body: AgentJournalMessageItem
): { agent: true } | { typist: SlackMirrorTypist } {
  const typedBy = body.typedBy
  if (typedBy?.by === 'agent') {
    return { agent: true }
  }
  if (typedBy?.by !== 'device') {
    return { typist: { kind: 'host' } }
  }
  const name = typedBy.account?.slice(0, 80)
  return { typist: name ? { kind: 'account', name } : { kind: 'computer' } }
}

/** Stages a message's files, then posts its words naming them; one with nothing to post fails as
 *  `empty`. The cloud splits long text, and any refusal it has comes back as its error. */
export async function postSlackMirrorMessage(
  call: SlackMirrorCall,
  message: {
    clientMessageId: string
    conversation: ConnectorConversation
    body: AgentJournalMessageItem
    orcaName: string
  }
): Promise<ConnectorResult<unknown>> {
  const { clientMessageId, conversation } = message
  const { text, paths } = slackMirrorContent(message.body)
  const refuse = (error: string): ConnectorResult<unknown> => ({
    ok: false,
    status: 409,
    error,
    retryAfterMs: null
  })
  const staged = await stageFiles(call, clientMessageId, conversation, paths)
  if ('error' in staged) {
    return refuse(staged.error)
  }
  if (!text && staged.fileIds.length === 0) {
    return refuse('empty')
  }
  const post: SlackMirrorPostBody = {
    v: 1,
    clientMessageId,
    conversation,
    text,
    ...(staged.fileIds.length > 0 ? { files: staged.fileIds } : {}),
    author: {
      orcaName: message.orcaName.slice(0, 80) || 'Orca',
      ...slackMirrorTypist(message.body)
    }
  }
  return slackMirrorCall(call, '', post, SlackMirrorPostResponse)
}

async function stageFiles(
  call: SlackMirrorCall,
  clientMessageId: string,
  conversation: ConnectorConversation,
  paths: string[]
): Promise<{ fileIds: string[] } | { error: string }> {
  const fileIds: string[] = []
  for (const [index, path] of paths.slice(0, SLACK_MIRROR_MAX_FILES).entries()) {
    const bytes = await readFile(path).catch(() => null)
    if (!bytes) {
      continue
    }
    const fileId = `${clientMessageId}:${index}`
    const body: SlackMirrorFileBody = {
      v: 1,
      clientMessageId,
      fileId,
      conversation,
      file: { name: basename(path).slice(0, 255), data: bytes.toString('base64') }
    }
    const staged = await slackMirrorCall(call, 'files', body)
    if (!staged.ok) {
      // No size cap of the desktop's own: the cloud's request-body limit answers 413.
      return { error: staged.error ?? (staged.status === 413 ? 'file_too_large' : 'transient') }
    }
    fileIds.push(fileId)
  }
  return { fileIds }
}
