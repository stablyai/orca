// Every phone "Copy URL": the hook's key-bearing URL, read from its host on the owner's tap and copied
// without being shown.
import type { ClipboardWriter } from '../../platform/clipboard/clipboard'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { webhookKeyReveal } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'
import { webhookReplyErrorCode, type WebhookErrorCode } from './mobile-webhook-copy'
import { WEBHOOK_WRITE } from './mobile-webhook-operations'

export type PhoneWebhookUrlCopy =
  | { kind: 'copied' }
  /** The host refused; `code` words it. */
  | { kind: 'refused'; code: WebhookErrorCode }
  /** The caller no longer wants it (its page closed, or the key rotated): nothing copied. */
  | { kind: 'dropped' }

/** Rejects when the clipboard refuses the text. `what`: the URL, or the header key alone. */
export async function copyPhoneWebhookUrl(
  client: RpcClient,
  hookId: string,
  clipboard: ClipboardWriter,
  wanted: () => boolean = () => true,
  what: 'url' | 'key' = 'url'
): Promise<PhoneWebhookUrlCopy> {
  const reply = await webhookKeyReveal.request(client, { hookId }, WEBHOOK_WRITE)
  if (!wanted()) {
    return { kind: 'dropped' }
  }
  if (!reply.ok) {
    return { kind: 'refused', code: webhookReplyErrorCode(reply.error.code) }
  }
  const key = webhookKeyReveal.interpret(reply)
  const text = what === 'url' ? key.url : key.key
  if (text === undefined) {
    return { kind: 'refused', code: 'host_needs_update' }
  }
  await clipboard.writeText(text)
  return { kind: 'copied' }
}
