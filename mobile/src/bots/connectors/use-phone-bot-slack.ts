// The bot's Slack as its host's Orca Cloud answers it, like the desktop's bot-slack-state: read again on the
// route's reads and on refresh; a failed re-read keeps the last answer unless the host is signed out.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type ConnectorBotSlackStateResponse
} from '../../../../src/shared/connector-bot-slack-contract'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { hostReadClient } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { slackStateRead } from './bot-slack-operations'

export type PhoneSlackView =
  | { status: 'loading' }
  | { status: 'ready'; slack: ConnectorBotSlackStateResponse }
  | { status: 'failed'; error: string }

/** Null while the phone can't reach the host: the offline banner says so, and the reconnect reads again. */
async function readSlack(client: RpcClient, botId: string): Promise<PhoneSlackView | null> {
  try {
    const answer = slackStateRead.interpret(
      await slackStateRead.request(hostReadClient(client), { botId })
    )
    return answer.ok
      ? { status: 'ready', slack: answer.value }
      : { status: 'failed', error: answer.error }
  } catch (error) {
    return isHostNotConnectedError(error)
      ? null
      : { status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed }
  }
}

const ROUTE_READ_MS = 60_000

/** `again`: the route's read count; null client or `enabled` false reads nothing. */
export function usePhoneBotSlack(
  client: RpcClient | null,
  botId: string,
  again: number,
  enabled: boolean
): { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> } {
  const [shown, setShown] = useState<{ botId: string; view: PhoneSlackView }>({
    botId,
    view: { status: 'loading' }
  })
  const view: PhoneSlackView = shown.botId === botId ? shown.view : { status: 'loading' }
  // A newer read doesn't drop one in flight, which busy route reads would starve; only an older answer is.
  const order = useRef({ botId, sent: 0, shown: 0, asked: 0, view })
  order.current.view = view
  const refresh = useCallback(async (): Promise<PhoneSlackView> => {
    if (!client) {
      return order.current.view
    }
    if (order.current.botId !== botId) {
      order.current = { botId, sent: 0, shown: 0, asked: 0, view: { status: 'loading' } }
    }
    const current = order.current
    current.asked = Date.now()
    const sent = ++current.sent
    const read = await readSlack(client, botId)
    if (!read || order.current !== current || sent < current.shown) {
      return order.current.view
    }
    current.shown = sent
    // A background failure keeps what showed; signed out is news the owner acts on.
    const kept =
      read.status === 'failed' &&
      read.error !== BOT_SLACK_DESKTOP_ERRORS.signedOut &&
      current.view.status === 'ready'
    if (!kept) {
      current.view = read
      setShown({ botId, view: read })
    }
    return current.view
  }, [client, botId])
  useEffect(() => {
    // Each route read is a cloud call on the host: like the desktop's focus read, at most once a minute.
    const recent =
      order.current.botId === botId &&
      order.current.view.status === 'ready' &&
      Date.now() - order.current.asked < ROUTE_READ_MS
    if (enabled && !recent) {
      void refresh()
    }
  }, [enabled, refresh, again, botId])
  return { view, refresh }
}
