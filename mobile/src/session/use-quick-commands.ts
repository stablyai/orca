import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import {
  applyTerminalQuickCommandMutation,
  type TerminalQuickCommandMutation
} from '../terminal/quick-commands'
import type { HostSessionQuickCommandOperations } from './host-session-quick-command-operations'

type Args = {
  operations: HostSessionQuickCommandOperations | null
  workspaceId: string
  // Fetch only while the sheet is open — quick commands are settings data we
  // don't need to keep hydrated for every session screen.
  enabled: boolean
}

type QuickCommandsState = {
  commands: TerminalQuickCommand[]
  loading: boolean
  ready: boolean
  error: string | null
  totalCount: number
  repoId: string | null
  // Optimistically apply against the latest local list, then serialize writes.
  // The server re-normalizes and returns the canonical list, which we adopt.
  persist: (mutation: TerminalQuickCommandMutation) => Promise<boolean>
}

type PendingMutation = {
  id: number
  mutation: TerminalQuickCommandMutation
}

type MutationContext = {
  operations: HostSessionQuickCommandOperations
  workspaceId: string
  confirmed: TerminalQuickCommand[]
  pending: PendingMutation[]
  queue: Promise<void>
  nextMutationId: number
}

export function useQuickCommands({ operations, workspaceId, enabled }: Args): QuickCommandsState {
  const [commands, setCommands] = useState<TerminalQuickCommand[]>([])
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [repoId, setRepoId] = useState<string | null>(null)
  const commandsRef = useRef<TerminalQuickCommand[]>([])
  const operationIdRef = useRef(0)
  const mutationContextRef = useRef<MutationContext | null>(null)

  useEffect(() => {
    if (!enabled || !operations) {
      setReady(false)
      return
    }
    let mutationContext = mutationContextRef.current
    if (mutationContext?.operations !== operations || mutationContext.workspaceId !== workspaceId) {
      // A request for an old host must not delay or update mutations on a new one.
      mutationContext = {
        operations,
        workspaceId,
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
    const abortController = new AbortController()
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
        const snapshot = await operations.snapshot(workspaceId, abortController.signal)
        if (
          stale ||
          operationId !== operationIdRef.current ||
          mutationContextRef.current !== mutationContext
        ) {
          return
        }
        mutationContext.confirmed = snapshot.commands
        commandsRef.current = snapshot.commands
        setCommands(snapshot.commands)
        setTotalCount(snapshot.totalCount)
        setRepoId(snapshot.repoId)
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
      abortController.abort()
    }
  }, [enabled, operations, workspaceId])

  const persist = useCallback(
    async (commandMutation: TerminalQuickCommandMutation) => {
      // Why: the loaded list is the optimistic/rollback baseline; mutating
      // before it arrives would make failure recovery show invented state.
      const mutationContext = mutationContextRef.current
      if (
        !operations ||
        loading ||
        !ready ||
        mutationContext?.operations !== operations ||
        mutationContext.workspaceId !== workspaceId
      ) {
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
          const snapshot = await operations.mutate(workspaceId, commandMutation)
          mutationContext.confirmed = snapshot.commands
          setTotalCount(snapshot.totalCount)
          setRepoId(snapshot.repoId)
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
    [loading, operations, ready, workspaceId]
  )

  return { commands, loading, ready, error, totalCount, repoId, persist }
}
