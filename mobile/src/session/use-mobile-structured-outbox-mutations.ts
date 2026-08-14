import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import {
  reconcileStructuredAgentSessionOutbox,
  updateStructuredAgentSessionOutboxEntry
} from '../../../src/shared/structured-agent-session-outbox'
import type { MobileStructuredOutboxHydration } from './mobile-structured-outbox-hydration'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'

type PersistOutbox = (sessionId: string, entries: MobileStructuredOutboxEntry[]) => Promise<void>

export function useMobileStructuredOutboxMutations(args: {
  activeSessionRef: MutableRefObject<string | null>
  hydrationRef: MutableRefObject<MobileStructuredOutboxHydration | null>
  outboxRef: MutableRefObject<MobileStructuredOutboxEntry[]>
  setOutbox: Dispatch<SetStateAction<MobileStructuredOutboxEntry[]>>
  persist: PersistOutbox
}) {
  const { activeSessionRef, hydrationRef, outboxRef, persist, setOutbox } = args
  const tailRef = useRef<Promise<void>>(Promise.resolve())
  const sessionGenerationRef = useRef(0)

  const serialize = useCallback(<T>(mutation: () => Promise<T>): Promise<T> => {
    const operation = tailRef.current.then(mutation, mutation)
    tailRef.current = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }, [])

  const beginSession = useCallback(() => {
    sessionGenerationRef.current += 1
  }, [])

  const isCurrent = useCallback(
    (sessionId: string, generation: number) =>
      activeSessionRef.current === sessionId && sessionGenerationRef.current === generation,
    [activeSessionRef]
  )

  const commit = useCallback(
    async (sessionId: string, generation: number, next: MobileStructuredOutboxEntry[]) => {
      await persist(sessionId, next)
      if (!isCurrent(sessionId, generation)) {
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      return true
    },
    [isCurrent, outboxRef, persist, setOutbox]
  )

  const reconcile = useCallback(
    (sessionId: string, submissions: readonly AgentJournalSubmission[]) => {
      const generation = sessionGenerationRef.current
      return serialize(async () => {
        if (!isCurrent(sessionId, generation)) {
          return
        }
        const current = outboxRef.current
        const next = reconcileStructuredAgentSessionOutbox(current, submissions)
        if (
          next.length === current.length &&
          next.every((entry, index) => entry === current[index])
        ) {
          return
        }
        await commit(sessionId, generation, next)
      })
    },
    [commit, isCurrent, outboxRef, serialize]
  )

  const normalizeDispatching = useCallback(
    (sessionId: string) => {
      const generation = sessionGenerationRef.current
      return serialize(async () => {
        if (!isCurrent(sessionId, generation)) {
          return
        }
        const current = outboxRef.current
        const next = current.map((entry) =>
          entry.state === 'dispatching' ? { ...entry, state: 'queued' as const } : entry
        )
        if (next.every((entry, index) => entry === current[index])) {
          return
        }
        await commit(sessionId, generation, next)
      })
    },
    [commit, isCurrent, outboxRef, serialize]
  )

  const replaceEntry = useCallback(
    (
      sessionId: string,
      id: string,
      update: (entry: MobileStructuredOutboxEntry) => MobileStructuredOutboxEntry | null
    ) => {
      const generation = sessionGenerationRef.current
      return serialize(async () => {
        if (!isCurrent(sessionId, generation)) {
          return
        }
        const next = updateStructuredAgentSessionOutboxEntry(outboxRef.current, id, update)
        await commit(sessionId, generation, next)
      })
    },
    [commit, isCurrent, outboxRef, serialize]
  )

  const enqueue = useCallback(
    (
      sessionId: string,
      hydration: MobileStructuredOutboxHydration,
      entry: MobileStructuredOutboxEntry
    ) => {
      const generation = sessionGenerationRef.current
      return serialize(async () => {
        if (!isCurrent(sessionId, generation) || hydrationRef.current !== hydration) {
          return false
        }
        const next = [...outboxRef.current, entry]
        return commit(sessionId, generation, next)
      })
    },
    [commit, hydrationRef, isCurrent, outboxRef, serialize]
  )

  return useMemo(
    () => ({ beginSession, enqueue, normalizeDispatching, reconcile, replaceEntry }),
    [beginSession, enqueue, normalizeDispatching, reconcile, replaceEntry]
  )
}
