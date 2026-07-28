import { useEffect, useRef, type RefObject } from 'react'
import * as ExpoCrypto from 'expo-crypto'
import type { RpcClient } from '../transport/rpc-client'
import { createTerminalInputQueue, type TerminalInputQueue } from './terminal-input-queue'
import { getTerminalInputQueueRpcOutcome } from './terminal-send-rpc-response'

type TerminalInputQueueOptions = {
  readonly client: RpcClient | null
  readonly clientId: string | null
  readonly enabled: boolean
}

export function useTerminalInputQueue({
  client,
  clientId,
  enabled
}: TerminalInputQueueOptions): RefObject<TerminalInputQueue | null> {
  const queueRef = useRef<TerminalInputQueue | null>(null)

  useEffect(() => {
    queueRef.current?.close()
    queueRef.current = null
    if (!client || !clientId || !enabled) {
      return
    }
    const queue = createTerminalInputQueue({
      queueId: ExpoCrypto.randomUUID(),
      getConnectionState: client.getState,
      onConnectionStateChange: client.onStateChange,
      send: async (operation) => {
        const response = await client.sendRequest('terminal.send', {
          terminal: operation.terminal,
          text: operation.text,
          enter: false,
          client: { id: clientId, type: 'mobile' as const },
          inputQueue: {
            id: operation.queueId,
            sequence: operation.sequence
          }
        })
        const outcome = getTerminalInputQueueRpcOutcome(response, {
          id: operation.queueId,
          sequence: operation.sequence
        })
        if (outcome === 'unacknowledged') {
          throw new Error('Terminal input acknowledgement was not received')
        }
        return outcome
      }
    })
    queueRef.current = queue
    return () => {
      queue.close()
      if (queueRef.current === queue) {
        queueRef.current = null
      }
    }
  }, [client, clientId, enabled])

  return queueRef
}
