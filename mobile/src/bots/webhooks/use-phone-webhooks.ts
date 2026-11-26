// A bot's hooks and one hook's recent calls, read from the host the route reaches: again on the route's
// reads and after each owner change (the open page also asks every 30 s); a failed re-read keeps the last answer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { hostReadClient } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { webhookReplyErrorCode, type WebhookErrorCode } from './mobile-webhook-copy'
import {
  webhookCallsRead,
  webhooksListRead,
  type PhoneWebhook,
  type PhoneWebhookCall
} from './mobile-webhook-operations'

export type PhoneWebhookRead<T> =
  | { status: 'loading' }
  /** refreshError: the latest read failed, so this is the last good answer. */
  | { status: 'ready'; value: T; refreshError: WebhookErrorCode | null }
  | { status: 'failed'; error: WebhookErrorCode }

/** Null while the phone can't reach the host: the offline banner says so, and the reconnect reads again. */
async function readOnce<T>(
  send: () => Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => T
): Promise<{ ok: true; value: T } | { ok: false; error: WebhookErrorCode } | null> {
  try {
    const reply = await send()
    if (!reply.ok) {
      return { ok: false, error: webhookReplyErrorCode(reply.error.code) }
    }
    return { ok: true, value: interpret(reply) }
  } catch (error) {
    return isHostNotConnectedError(error) ? null : { ok: false, error: webhookReplyErrorCode(null) }
  }
}

function useHostRead<T>(
  key: string | null,
  load: (() => Promise<RpcResponse>) | null,
  interpret: (reply: RpcResponse) => T,
  again: number
): PhoneWebhookRead<T> {
  const [read, setRead] = useState<{ key: string | null; value: PhoneWebhookRead<T> }>({
    key,
    value: { status: 'loading' }
  })
  // A newer request doesn't drop one in flight: the bot's busy route reads would starve every answer.
  // Only an answer for another key, or older than one already shown, is dropped.
  const order = useRef({ key, sent: 0, shown: 0 })
  useEffect(() => {
    if (!load) {
      return
    }
    order.current.key = key
    const sent = ++order.current.sent
    void readOnce(load, interpret).then((answer) => {
      if (!answer || order.current.key !== key || sent < order.current.shown) {
        return
      }
      order.current.shown = sent
      setRead((current) => {
        const previous = current.key === key ? current.value : { status: 'loading' as const }
        if (answer.ok) {
          return { key, value: { status: 'ready', value: answer.value, refreshError: null } }
        }
        // A deleted hook is gone; any other failure keeps what was showing, with the reason beside it.
        return {
          key,
          value:
            previous.status === 'ready' && answer.error !== 'webhook_not_found'
              ? { ...previous, refreshError: answer.error }
              : { status: 'failed', error: answer.error }
        }
      })
    })
    // The key names everything `load` reads.
  }, [key, again])
  return read.key === key ? read.value : { status: 'loading' }
}

/** The bot's hooks; `changed` reads them (and the open hook's calls) again. `reads` is the route's read count. */
export function usePhoneWebhooks(
  client: RpcClient | null,
  botId: string,
  reads: number
): { read: PhoneWebhookRead<PhoneWebhook[]>; changed: () => void; version: number } {
  // A read fails at once while the host is down instead of queueing a poll for the reconnect.
  const reader = client && hostReadClient(client)
  const [version, setVersion] = useState(0)
  const changed = useCallback(() => setVersion((value) => value + 1), [])
  const read = useHostRead(
    reader ? botId : null,
    reader ? () => webhooksListRead.request(reader, { botId }) : null,
    (reply) => webhooksListRead.interpret(reply).hooks,
    reads + version
  )
  // The open hook's calls read again with the list: on the route's reads and after each change.
  return { read, changed, version: reads + version }
}

/** One hook's recent calls, newest first; read while its page shows. */
export function usePhoneWebhookCalls(
  client: RpcClient | null,
  hookId: string,
  again: number
): PhoneWebhookRead<PhoneWebhookCall[]> {
  const reader = client && hostReadClient(client)
  return useHostRead(
    reader ? hookId : null,
    reader ? () => webhookCallsRead.request(reader, { hookId }) : null,
    (reply) => webhookCallsRead.interpret(reply).calls,
    again
  )
}
