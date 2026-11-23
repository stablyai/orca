// The reads behind Who can ask's lists: the agent's Slack, and the owner's Linear and GitHub links.
import { useEffect, useRef, useState } from 'react'
import type { BotSlackResult } from '../../../src/shared/connector-bot-slack-contract'
import { botLinearWorkspaces, botSlackApps } from '../../../src/shared/bot-types'
import type { Translate } from '../i18n/mobile-i18n'
import { hostReadClient } from '../query/host-read-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { gitHubStateRead, linearStateRead } from './connectors/bot-connector-people-operations'
import { slackCall } from './connectors/bot-slack-operations'
import { usePhoneBotSlack } from './connectors/use-phone-bot-slack'
import type { PhoneBot } from './host-bots-operations'
import { whoCanAskConnectors, type WhoCanAskConnector } from './who-can-ask-connectors'

const ROUTE_READ_MS = 60_000

/** The owner's Linear or GitHub links on the host; read as the page opens and with the route's reads
 *  (reconnect, foreground), at most once a minute once one landed, as Slack's is. Null unread. */
function useLinkState<T>(
  client: RpcClient | null,
  read: (client: RpcClient) => Promise<BotSlackResult<T>>,
  enabled: boolean,
  again: number
): { value: T | null; checking: boolean } {
  const [state, setState] = useState<{ value: T | null; checking: boolean }>({
    value: null,
    checking: true
  })
  // A newer read doesn't drop one in flight, which busy route reads would starve; only an older answer is.
  const order = useRef({ sent: 0, shown: 0, landed: 0 })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!client || !enabled || Date.now() - order.current.landed < ROUTE_READ_MS) {
      return
    }
    const sent = ++order.current.sent
    void read(client).then((answer) => {
      if (!alive.current || sent < order.current.shown) {
        return
      }
      order.current.shown = sent
      if (answer.ok) {
        order.current.landed = Date.now()
      }
      // A failed re-read keeps what showed.
      setState((shown) => ({ value: answer.ok ? answer.value : shown.value, checking: false }))
    })
  }, [client, read, enabled, again])
  return state
}

const readLinear = (client: RpcClient) =>
  slackCall(() => linearStateRead.request(hostReadClient(client)), linearStateRead.interpret)
const readGitHub = (client: RpcClient) =>
  slackCall(() => gitHubStateRead.request(hostReadClient(client)), gitHubStateRead.interpret)

export function useWhoCanAskConnectors(
  client: RpcClient | null,
  bot: PhoneBot,
  reads: number,
  hostName: string,
  t: Translate
): WhoCanAskConnector[] {
  const slack = usePhoneBotSlack(client, bot.id, reads, botSlackApps(bot).length > 0)
  const linear = useLinkState(client, readLinear, botLinearWorkspaces(bot).length > 0, reads)
  const github = useLinkState(client, readGitHub, bot.github !== null, reads)
  return whoCanAskConnectors({ client, bot, hostName, t, slack, linear, github })
}
