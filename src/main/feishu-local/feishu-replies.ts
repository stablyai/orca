import { createHash } from 'node:crypto'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuReply, FeishuTransport } from './feishu-transport'
export async function replyFeishu(
  api: Pick<FeishuTransport, 'reply'>,
  account: string,
  original: string,
  chat: string,
  message: FeishuReply,
  part: 'final' | 'progress' | 'file'
): Promise<void> {
  const uuid = createHash('sha256')
    .update(JSON.stringify(part === 'final' ? [account, original] : [account, original, part]))
    .digest('hex')
    .slice(0, 48)
  await api.reply(original, chat, message, uuid)
}

/** Raw post content keeps external image references from being fetched. */
export function finalFeishuMessage(text: string): { type: 'post' | 'text'; content: unknown } {
  if (!text.trim() || text.includes('![') || /<img\b/i.test(text)) {
    return { type: 'text', content: { text } }
  }
  return { type: 'post', content: { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } } }
}
/** Progress is best effort: reserve once before posting so a lost receipt cannot repeat the notice. */
export async function acknowledgeFeishuMessage(
  api: Pick<FeishuTransport, 'reply'>,
  inbox: FeishuStore,
  b: Binding,
  mid: string,
  signal: AbortSignal,
  active: () => boolean
): Promise<void> {
  if (
    !b.chat ||
    signal.aborted ||
    !active() ||
    !(await inbox.takeProgress(b.account, mid)) ||
    !active()
  ) {
    return
  }
  await replyFeishu(
    api,
    b.account,
    mid,
    b.chat,
    { type: 'text', content: { text: 'Received in Orca. I’m working on this.' } },
    'progress'
  ).catch(() => {})
}
