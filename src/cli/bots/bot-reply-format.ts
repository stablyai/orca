// What `orca bot reply` prints for each thing it did.
import type { ActionResult } from '../slack/slack-action-format'

// notices: why the reply can't wake an Orca bot it mentions.
export type ConnectorReply = { status: 'posted' | 'queued'; place?: string; notices?: string[] }

export type BotReplyResult = {
  reacted?: string
  reply?: ConnectorReply
  attached?: ActionResult & { files: number; posts: number; place?: string; unconfirmed?: true }
  offered?: ActionResult & { choices: number; place?: string; unconfirmed?: true }
}

export function formatOffered(offered: NonNullable<BotReplyResult['offered']>): string {
  const place = offered.place ?? offered.target?.label ?? 'the thread'
  // Slack took the words without their buttons: the cloud's note says so, and no press will come.
  if (offered.note) {
    return [`Posted to ${place}.`, offered.note, ...(offered.notices ?? [])].join('\n')
  }
  return [
    offered.queued
      ? `Sent with ${offered.choices} buttons; Orca Cloud will post it to ${place}.${offered.unconfirmed ? " Orca couldn't confirm it posted; read the thread before sending it again." : ''}`
      : `Posted to ${place} with ${offered.choices} buttons.`,
    // The agent waits on this, so it should know what a press looks like when it comes.
    "A press comes back to you as that person's next message in this thread, with the button's label as its text.",
    ...(offered.notices ?? [])
  ].join('\n')
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

export function formatAttached(attached: NonNullable<BotReplyResult['attached']>): string {
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
