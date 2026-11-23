import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BotAccessDecision,
  ConnectorAccessRequest
} from '../../../src/shared/connector-bot-access-contract'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { accessDecideFailureLine } from './bot-access-request-copy'
import { botAccessRequestsRead, decideBotAccessRequest } from './bot-access-request-operations'
import type { RouteBot } from './use-route-bot'

export type BotAccessRequests = {
  requests: readonly ConnectorAccessRequest[]
  deciding: boolean
  decide: (request: ConnectorAccessRequest, decision: BotAccessDecision) => Promise<void>
}

const NONE: readonly ConnectorAccessRequest[] = []

/** The route bot's waiting requests, read as the sheet opens and again with each route read while it is open; null without a route bot. */
export function useBotAccessRequests({
  client,
  routeBot,
  visible,
  showToast
}: {
  client: RpcClient | null
  routeBot: RouteBot | null
  visible: boolean
  showToast: (message: string, durationMs?: number) => void
}): BotAccessRequests | null {
  const [requests, setRequests] = useState<readonly ConnectorAccessRequest[]>(NONE)
  const [deciding, setDeciding] = useState(false)
  // Answered here: a read that started before the host saved it must not bring it back, as on the desktop.
  const answered = useRef(new Set<string>())
  const botId = routeBot?.bot.id ?? null
  const refreshRoute = routeBot?.refresh
  // The host's botsChanged covers its waiting list too.
  const routeReads = routeBot?.reads ?? 0

  useEffect(() => {
    if (!visible || !client || !botId) {
      return
    }
    let current = true
    void (async () => {
      const reply = await botAccessRequestsRead.request(client).catch(() => null)
      const read = reply && readHostMethodReply(reply, botAccessRequestsRead.interpret)
      // A failed read keeps the last rows.
      if (current && read?.kind === 'answered' && read.value.ok) {
        setRequests(
          read.value.value.filter(
            (request) => request.botId === botId && !answered.current.has(request.requestId)
          )
        )
      }
    })()
    return () => {
      current = false
    }
  }, [visible, client, botId, routeReads])

  const decide = useCallback(
    async (request: ConnectorAccessRequest, decision: BotAccessDecision) => {
      if (!client) {
        return
      }
      setDeciding(true)
      try {
        const answer = await decideBotAccessRequest(client, request.requestId, decision)
        if (answer.ok || answer.error === 'expired') {
          answered.current.add(request.requestId)
          setRequests((rows) => rows.filter((row) => row.requestId !== request.requestId))
        }
        if (!answer.ok) {
          showToast(accessDecideFailureLine(request, answer.error), 2400)
        }
        // The host added the person; show them under People with access.
        if (answer.ok && decision === 'granted') {
          refreshRoute?.()
        }
      } finally {
        setDeciding(false)
      }
    },
    [client, showToast, refreshRoute]
  )

  return botId ? { requests, deciding, decide } : null
}
