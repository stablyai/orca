import { useCallback, useEffect, useState } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { subscribeSharedClientEvents } from '../../../../transport/connection/shared-client-events'
import { toSafeDisplayLine } from '../../../../../../src/shared/text/display-text-safety'
import { useOptionalHostProtocolGates } from '../../../../components/host-connection/host-protocol-gates-context'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../../../../src/shared/orchestration/orchestration-runtime-capabilities'
import {
  PairedServerAskList,
  type PairedServerAskCard
} from '../../../../../../src/shared/rpc-contract/paired-server-asks-params'
import {
  readBotChangeScope,
  botChangeConcerns
} from '../../../../../../src/shared/bots/bot-change-scope'

export type MobilePairedServerDecision = 'once' | 'always' | 'deny'

export type MobilePairedServerAsks = {
  /** Asks from paired servers' agents to this chat's agent, oldest first. */
  open: readonly PairedServerAskCard[]
  /** Resolves once the host took the answer; a card answered elsewhere leaves on its own. */
  answer: (card: PairedServerAskCard, decision: MobilePairedServerDecision) => Promise<boolean>
}

const NONE: readonly PairedServerAskCard[] = []

/** Who on the paired server asks: its agent's bot name, else its own name, else how it signs. */
export function pairedServerAskerName(card: PairedServerAskCard): string {
  return toSafeDisplayLine(card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label)
}

const listCards = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'paired-server-asks.list',
    method: 'pairedServerAsks.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('paired-server-asks', PairedServerAskList)
  })
)

const decideCard = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'paired-server-asks.decide',
    method: 'pairedServerAsks.decide',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('paired-server-ask-decision', z.looseObject({ decided: z.boolean() }))
  })
)

/** The cards waiting on the person for one agent, by its Home chat or its id, on the host that holds
 *  them, re-read with each of its chats notices; none on a host that takes no such asks. */
export function useMobilePairedServerAsks({
  client,
  connected,
  sessionId = null,
  botId = null,
  onAnswerError
}: {
  client: RpcClient | null
  connected: boolean
  sessionId?: string | null
  botId?: string | null
  onAnswerError: (message: string) => void
}): MobilePairedServerAsks {
  const supported =
    useOptionalHostProtocolGates()?.hostCapabilities.includes(
      ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY
    ) === true
  const [cards, setCards] = useState<readonly PairedServerAskCard[]>(NONE)

  useEffect(() => {
    setCards(NONE)
    if (!supported || !client || !connected || (!sessionId && !botId)) {
      return
    }
    let live = true
    const read = (): void => {
      void listCards
        .request(client, botId ? { botId } : {})
        .then((reply) => {
          const shown = listCards
            .interpret(reply)
            .cards.filter((card) => !sessionId || card.botChatSessionId === sessionId)
          if (live) {
            setCards(shown.length > 0 ? shown : NONE)
          }
        })
        // A failed read keeps the cards it showed.
        .catch(() => {})
    }
    const stop = subscribeSharedClientEvents(client, (event) => {
      if (
        event.type === 'ready' ||
        (event.type === 'botsChanged' &&
          botChangeConcerns(readBotChangeScope(event), {
            ...(botId ? { botId } : {}),
            kinds: ['chats']
          }))
      ) {
        read()
      }
    })
    return () => {
      live = false
      stop()
    }
  }, [client, connected, sessionId, botId, supported])

  const answer = useCallback(
    async (card: PairedServerAskCard, decision: MobilePairedServerDecision): Promise<boolean> => {
      if (!client) {
        return false
      }
      try {
        decideCard.interpret(
          await decideCard.request(client, { messageId: card.messageId, decision })
        )
        return true
      } catch (error) {
        onAnswerError(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [client, onAnswerError]
  )
  return { open: cards, answer }
}
