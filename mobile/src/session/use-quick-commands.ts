import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  interpretOrThrowRefusalMessage,
  refusedRpcMessageOrFallback
} from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import { quickCommandsRead } from './mobile-session-read-operations'
import { quickCommandsWrite } from './mobile-session-write-operations'
import {
  applyTerminalQuickCommandMutation,
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../terminal/quick-commands'

type Args = {
  client: RpcClient | null
  // Hydrate only while open; session screens do not otherwise need quick-command settings.
  enabled: boolean
}

type QuickCommandsState = {
  commands: TerminalQuickCommand[]
  loading: boolean
  ready: boolean
  error: string | null
  // Serialize optimistic writes and adopt the host’s canonical result.
  persist: (mutation: TerminalQuickCommandMutation) => Promise<boolean>
}

type PendingMutation = {
  id: number
  mutation: TerminalQuickCommandMutation
}

type MutationContext = {
  client: RpcClient
  confirmed: TerminalQuickCommand[]
  pending: PendingMutation[]
  queue: Promise<void>
  nextMutationId: number
}

const LOAD_CUTOVER_MAX_RETRIES = 5

// Relay-to-direct cutover can reject reads while still connected; safely replay instead of leaving the sheet empty.
async function loadQuickCommandsWithCutoverRetry(
  client: RpcClient,
  cancelled: () => boolean
): Promise<RpcResponse> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      return await quickCommandsRead.request(client)
    } catch (error) {
      if (
        cancelled() ||
        !isLogicalClientCutoverError(error) ||
        migrationRetry >= LOAD_CUTOVER_MAX_RETRIES
      ) {
        throw error
      }
    }
  }
}

export function useQuickCommands({ client, enabled }: Args): QuickCommandsState {
  const [commands, setCommands] = useState<TerminalQuickCommand[]>([])
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const commandsRef = useRef<TerminalQuickCommand[]>([])
  const operationIdRef = useRef(0)
  const mutationContextRef = useRef<MutationContext | null>(null)

  useEffect(() => {
    if (!enabled || !client) {
      setReady(false)
      return
    }
    let mutationContext = mutationContextRef.current
    if (mutationContext?.client !== client) {
      // Old-host requests must neither delay nor update new-host mutations.
      mutationContext = {
        client,
        confirmed: [],
        pending: [],
        queue: Promise.resolve(),
        nextMutationId: 0
      }
      mutationContextRef.current = mutationContext
      commandsRef.current = []
      setCommands([])
    }
    let stale = false
    const operationId = operationIdRef.current + 1
    operationIdRef.current = operationId
    setLoading(true)
    setReady(false)
    setError(null)

    void (async () => {
      try {
        // Wait for overlapping saves before reading so stale snapshots cannot replace their canonical result.
        await mutationContext.queue
        if (
          stale ||
          operationId !== operationIdRef.current ||
          mutationContextRef.current !== mutationContext
        ) {
          return
        }
        const response = await loadQuickCommandsWithCutoverRetry(
          client,
          () =>
            stale ||
            operationId !== operationIdRef.current ||
            mutationContextRef.current !== mutationContext
        )
        if (
          stale ||
          operationId !== operationIdRef.current ||
          mutationContextRef.current !== mutationContext
        ) {
          return
        }
        let next
        try {
          next = parseNormalizedTerminalQuickCommands(quickCommandsRead.interpret(response))
        } catch (err) {
          setError(refusedRpcMessageOrFallback(err, 'Failed to load quick commands'))
          return
        }
        if (!next) {
          setError('Failed to load quick commands')
          return
        }
        mutationContext.confirmed = next
        commandsRef.current = next
        setCommands(next)
        setReady(true)
      } catch (err) {
        if (
          !stale &&
          operationId === operationIdRef.current &&
          mutationContextRef.current === mutationContext
        ) {
          setError(err instanceof Error ? err.message : 'Failed to load quick commands')
        }
      } finally {
        if (
          !stale &&
          operationId === operationIdRef.current &&
          mutationContextRef.current === mutationContext
        ) {
          setLoading(false)
        }
      }
    })()

    return () => {
      stale = true
    }
  }, [client, enabled])

  const persist = useCallback(
    async (commandMutation: TerminalQuickCommandMutation) => {
      // Wait for the rollback baseline; mutating before load would invent recovery state.
      const mutationContext = mutationContextRef.current
      if (!client || loading || !ready || mutationContext?.client !== client) {
        return false
      }
      const mutation: PendingMutation = {
        id: mutationContext.nextMutationId + 1,
        mutation: commandMutation
      }
      mutationContext.nextMutationId = mutation.id
      mutationContext.pending.push(mutation)
      const optimistic = applyTerminalQuickCommandMutation(commandsRef.current, commandMutation)
      commandsRef.current = optimistic
      setCommands(optimistic)
      setError(null)

      const send = async (): Promise<boolean> => {
        let succeeded = false
        let failureMessage: string | null = null
        try {
          const response = await quickCommandsWrite.request(client, {
            mutation: commandMutation
          })
          let confirmed
          confirmed = interpretOrThrowRefusalMessage(
            () => parseNormalizedTerminalQuickCommands(quickCommandsWrite.interpret(response)),
            'Failed to save quick command'
          )
          if (!confirmed) {
            // An invalid payload is not an empty list: adopting it could erase host commands on the next write.
            throw new Error('Failed to save quick command')
          }
          mutationContext.confirmed = confirmed
          succeeded = true
          return true
        } catch (err) {
          failureMessage = err instanceof Error ? err.message : 'Failed to save quick command'
          return false
        } finally {
          mutationContext.pending = mutationContext.pending.filter(
            (pending) => pending.id !== mutation.id
          )
          if (mutationContextRef.current === mutationContext) {
            const next = mutationContext.pending.reduce(
              (current, pending) => applyTerminalQuickCommandMutation(current, pending.mutation),
              mutationContext.confirmed
            )
            commandsRef.current = next
            setCommands(next)
            const hasNewerMutation = mutationContext.pending.some(
              (pending) => pending.id > mutation.id
            )
            if (!hasNewerMutation) {
              setError(succeeded ? null : failureMessage)
            }
          }
        }
      }
      const request = mutationContext.queue.then(send, send)
      mutationContext.queue = request.then(
        () => undefined,
        () => undefined
      )
      return await request
    },
    [client, loading, ready]
  )

  return { commands, loading, ready, error, persist }
}
