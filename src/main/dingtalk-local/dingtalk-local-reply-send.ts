import type { DingTalkSetup, ReplyRow } from './dingtalk-domain'
import type { DingTalkLedger } from './dingtalk-ledger'
import type { DwsBoundary } from './dws/dingtalk-dws-boundary'

type ReplySend = {
  ledger: DingTalkLedger
  dws: Pick<DwsBoundary, 'send'>
  setup: DingTalkSetup | null
  /** Reply keys with a send in flight, shared across calls so one reply is sent once at a time. */
  sending: Set<string>
}

/** Sends a queued reply through dws when auto-reply is on and its group is still configured. */
export async function sendDingTalkReplyIfEnabled(
  { ledger, dws, setup, sending }: ReplySend,
  reply: ReplyRow
): Promise<void> {
  if (!setup?.enabled || !setup.autoReply || sending.has(reply.key)) {
    return
  }
  const binding = setup.groups.find(
    (group) => group.profile === reply.profile && group.groupId === reply.groupId
  )
  if (!binding) {
    return
  }
  sending.add(reply.key)
  try {
    await ledger.transitionReply(reply.key, 'queued', 'sending')
    const outcome = await dws.send(reply.profile, reply.groupId, reply.text, reply.uuid)
    if (outcome.kind === 'sent') {
      await ledger.transitionReply(reply.key, 'sending', 'sent')
    } else if (outcome.kind === 'not-started') {
      await ledger.transitionReply(reply.key, 'sending', 'failed', { error: outcome.error })
    } else {
      await ledger.transitionReply(reply.key, 'sending', 'uncertain', { error: outcome.error })
    }
  } catch (error) {
    if (ledger.snapshot().replies[reply.key]?.state === 'sending') {
      await ledger.transitionReply(reply.key, 'sending', 'failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  } finally {
    sending.delete(reply.key)
  }
}
