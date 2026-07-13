import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

function fallbackState(
  targetId: string,
  status: SshConnectionState['status'],
  error: string | null
) {
  return { targetId, status, error, reconnectAttempt: 0 } satisfies SshConnectionState
}

async function readSshState(client: RpcClient, targetId: string): Promise<SshConnectionState> {
  const response = await client.sendRequest('ssh.getState', { targetId })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = (response as RpcSuccess).result as { state?: SshConnectionState | null }
  return result.state ?? fallbackState(targetId, 'disconnected', null)
}

export function useLiveWorkspaceSshState(args: {
  visible: boolean
  client: RpcClient | null
  targetId: string | null
}) {
  const [state, setState] = useState<SshConnectionState | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [generation, setGeneration] = useState(0)
  // Why: reads, stream events, and connects can race to publish the same target's state.
  const stateEpochRef = useRef(0)
  const connectOperationEpochRef = useRef(0)

  useEffect(() => {
    connectOperationEpochRef.current += 1
    setConnecting(false)
    if (!args.visible || !args.client || !args.targetId) {
      setState(null)
      return
    }
    const client = args.client
    const targetId = args.targetId
    let stale = false
    let eventStreamReady = false
    const refreshState = (invalidate: boolean): void => {
      const stateEpoch = ++stateEpochRef.current
      void readSshState(client, targetId)
        .then((nextState) => {
          if (!stale && stateEpoch === stateEpochRef.current) {
            setState(nextState)
            if (invalidate) {
              setGeneration((value) => value + 1)
            }
          }
        })
        .catch((error) => {
          if (!stale && stateEpoch === stateEpochRef.current) {
            setState(
              fallbackState(
                targetId,
                'error',
                error instanceof Error ? error.message : 'Failed to read SSH connection state.'
              )
            )
            if (invalidate) {
              setGeneration((value) => value + 1)
            }
          }
        })
    }
    const unsubscribe = client.subscribe('runtime.clientEvents.subscribe', null, (payload) => {
      const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
      if (event.type === 'ready') {
        const replayedAfterReconnect = eventStreamReady
        eventStreamReady = true
        if (replayedAfterReconnect) {
          // Why: events missed while offline make the last connected state unsafe
          // until a fresh host read closes the replay gap.
          setState(null)
          setGeneration((value) => value + 1)
          refreshState(true)
        }
        return
      }
      if (event.type === 'sshStateChanged' && event.targetId === targetId && event.state) {
        stateEpochRef.current += 1
        setState(event.state)
        setGeneration((value) => value + 1)
      }
    })
    refreshState(false)
    return () => {
      stale = true
      unsubscribe()
    }
  }, [args.client, args.targetId, args.visible])

  const connect = useCallback(async (): Promise<void> => {
    if (!args.client || !args.targetId) {
      return
    }
    const targetId = args.targetId
    const operationEpoch = ++connectOperationEpochRef.current
    const stateEpoch = ++stateEpochRef.current
    setConnecting(true)
    setState(fallbackState(targetId, 'connecting', null))
    setGeneration((value) => value + 1)
    try {
      const response = await args.client.sendRequest(
        'ssh.connect',
        { targetId },
        { timeoutMs: 120_000 }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = (response as RpcSuccess).result as { state?: SshConnectionState | null }
      if (
        operationEpoch === connectOperationEpochRef.current &&
        stateEpoch === stateEpochRef.current
      ) {
        setState(result.state ?? fallbackState(targetId, 'connected', null))
      }
    } catch (error) {
      if (
        operationEpoch === connectOperationEpochRef.current &&
        stateEpoch === stateEpochRef.current
      ) {
        setState(
          fallbackState(
            targetId,
            'error',
            error instanceof Error ? error.message : 'Failed to connect to SSH repository.'
          )
        )
      }
    } finally {
      // Why: switching repositories transfers ownership of connection state;
      // the previous target's completion cannot publish into the new target.
      if (operationEpoch === connectOperationEpochRef.current) {
        setGeneration((value) => value + 1)
        setConnecting(false)
      }
    }
  }, [args.client, args.targetId])

  return { state, connecting, generation, connect }
}
