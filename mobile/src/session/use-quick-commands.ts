import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import type { TerminalQuickCommand } from '../../../src/shared/types'
import {
  applyTerminalQuickCommandMutation,
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../terminal/quick-commands'

type Args = {
  client: RpcClient | null
  // Fetch only while the sheet is open — quick commands are settings data we
  // don't need to keep hydrated for every session screen.
  enabled: boolean
}

type QuickCommandsState = {
  commands: TerminalQuickCommand[]
  loading: boolean
  ready: boolean
  error: string | null
  // Optimistically apply against the latest local list, then serialize writes.
  // The server re-normalizes and returns the canonical list, which we adopt.
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

function readQuickCommands(result: unknown): TerminalQuickCommand[] | null {
  const list = (result as { terminalQuickCommands?: unknown } | null)?.terminalQuickCommands
  return parseNormalizedTerminalQuickCommands(list)
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
      // A request for an old host must not delay or update mutations on a new one.
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
        // A close/reopen can overlap an in-flight save. Read only after that
        // save settles so an older snapshot cannot replace its canonical result.
        await mutationContext.queue
        if (
          stale ||
          operationId !== operationIdRef.current ||
          mutationContextRef.current !== mutationContext
        ) {
          return
        }
        const response = await client.sendRequest('settings.getTerminalQuickCommands')
        if (
          stale ||
          operationId !== operationIdRef.current ||
          mutationContextRef.current !== mutationContext
        ) {
          return
        }
        if (!response.ok) {
          setError((response as RpcFailure).error.message || 'Failed to load quick commands')
          return
        }
        const next = readQuickCommands((response as RpcSuccess).result)
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
      // Why: the loaded list is the optimistic/rollback baseline; mutating
      // before it arrives would make failure recovery show invented state.
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
          const response = await client.sendRequest('settings.updateTerminalQuickCommands', {
            mutation: commandMutation
          })
          if (!response.ok) {
            throw new Error(
              (response as RpcFailure).error.message || 'Failed to save quick command'
            )
          }
          const confirmed = readQuickCommands((response as RpcSuccess).result)
          if (!confirmed) {
            // Why: treating an invalid success payload as [] would let the next
            // full-list mutation erase commands that still exist on the host.
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
