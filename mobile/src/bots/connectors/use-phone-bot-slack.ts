// The bot's Slack as its host's Orca Cloud answers it, like the desktop's bot-slack-state: read again on the
// route's reads and on refresh, one answer for every surface; a failed re-read keeps the last unless signed out.
import { useCallback, useEffect, useRef } from 'react'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type ConnectorBotSlackStateResponse
} from '../../../../src/shared/connector-bot-slack-contract'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { hostReadClient } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { slackStateRead } from './bot-slack-operations'
import {
  connectorReadCells,
  connectorReadKey,
  setConnectorRead,
  useConnectorRead,
  type ConnectorReadCell
} from './phone-connector-reads'

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

type SlackCell = ConnectorReadCell<PhoneSlackView> & {
  sent: number
  shown: number
  asked: number
  reading: number
}

const slackCells = connectorReadCells((): SlackCell => ({
  value: { status: 'loading' },
  sent: 0,
  shown: 0,
  asked: 0,
  reading: 0
}))

/** `again`: the route's read count; null client or `enabled` false reads nothing. */
export function usePhoneBotSlack(
  client: RpcClient | null,
  hostKey: string,
  botId: string,
  again: number,
  enabled: boolean
): { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> } {
  const key = connectorReadKey(hostKey, 'slack', botId)
  const view = useConnectorRead(slackCells(key))
  const refresh = useCallback(async (): Promise<PhoneSlackView> => {
    const cell = slackCells(key)
    if (!client) {
      return cell.value
    }
    cell.asked = Date.now()
    // A newer read doesn't drop one in flight, which busy route reads would starve; only an older answer is.
    const sent = ++cell.sent
    cell.reading += 1
    const read = await readSlack(client, botId).finally(() => {
      cell.reading -= 1
    })
    if (!read || sent < cell.shown) {
      return cell.value
    }
    cell.shown = sent
    // A background failure keeps what showed; signed out is news the owner acts on.
    const kept =
      read.status === 'failed' &&
      read.error !== BOT_SLACK_DESKTOP_ERRORS.signedOut &&
      cell.value.status === 'ready'
    if (!kept) {
      setConnectorRead(cell, read)
    }
    return cell.value
  }, [client, key, botId])
  // Each surface reads as it opens; another's read keeps only its later route reads back.
  const readHere = useRef<string | null>(null)
  useEffect(() => {
    // Each route read is a cloud call on the host: like the desktop's focus read, at most once a minute.
    const cell = slackCells(key)
    const opened = readHere.current !== key
    const recent =
      cell.reading > 0 ||
      (!opened && cell.value.status === 'ready' && Date.now() - cell.asked < ROUTE_READ_MS)
    if (enabled && !recent) {
      readHere.current = key
      void refresh()
    }
  }, [enabled, refresh, again, key])
  return { view, refresh }
}
