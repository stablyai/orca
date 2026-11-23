import { useCallback, useEffect, useReducer, useState } from 'react'
import { AppState } from 'react-native'
import { reduceBotGroupTranscript } from '../../../src/shared/bots/bot-group-transcript'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupRead } from './bot-group-operations'
import { readHostBots } from './host-bots-read'
import type { PhoneBot } from './host-bots-operations'
import { startHostBotRefresh } from './host-bot-refresh'
export function useMobileBotGroupTranscript(
  client: RpcClient,
  groupId: string,
  hostId: string,
  visible: boolean,
  setError: (message: string | null) => void
) {
  const [data, apply] = useReducer(reduceBotGroupTranscript, null)
  const [bots, setBots] = useState<PhoneBot[]>([])
  useEffect(() => {
    if (!visible) {
      return
    }
    let closed = false
    let request = 0
    const refresh = () => {
      const current = ++request
      void Promise.all([groupRead.request(client, { groupId }), readHostBots(client, hostId)])
        .then(([reply, bots]) => {
          if (closed || current !== request) {
            return
          }
          apply({ kind: 'recent', page: groupRead.interpret(reply) })
          if (bots.kind === 'bots') {
            setBots(bots.bots)
          }
        })
        .catch((error: unknown) => {
          if (!closed) {
            setError(String(error))
          }
        })
    }
    const stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh,
      listed: () => true,
      interest: () => ({ kinds: ['groups', 'bot'] })
    })
    return () => {
      closed = true
      stop()
    }
  }, [apply, client, groupId, hostId, visible, setError])
  const loadEarlier = useCallback(async () => {
    if (!data?.hasEarlier) {
      return
    }
    try {
      const result = groupRead.interpret(
        await groupRead.request(client, { groupId, beforeSequence: data.messages[0]?.sequence })
      )
      apply({ kind: 'earlier', page: result })
    } catch (error) {
      setError(String(error))
    }
  }, [apply, client, groupId, data, setError])
  return { data, apply, bots, loadEarlier }
}
