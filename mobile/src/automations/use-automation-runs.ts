import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automation-owner-precondition'
import { automationRunsRead } from './automation-operations'
import { automationErrorMessage } from './automation-error'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'

export function useAutomationRuns(
  client: RpcClient | null,
  filter: MobileAutomationRow | null,
  revision: number,
  connected: boolean
) {
  const [runs, setRuns] = useState<MobileAutomationRun[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scope = useRef(0)
  const request = useRef(0)
  const lock = useRef(false)
  const paged = useRef(false)
  const refreshPending = useRef(false)
  const filterId = filter?.automation.id
  const selector = filter?.item.selector
  const ownerKey = JSON.stringify(selector)
  const load = useCallback(
    async function readPage(next?: string): Promise<void> {
      if (!client || client.getState() !== 'connected') {
        return
      }
      if (lock.current) {
        if (!next) {
          refreshPending.current = true
        }
        return
      }
      lock.current = true
      setLoading(true)
      const at = scope.current
      const id = ++request.current
      const generation = client.getGeneration?.()
      try {
        const reply = await automationRunsRead.request(client, {
          limit: 30,
          ...(next ? { cursor: next } : {}),
          ...(filterId && selector
            ? { automationId: filterId, expectedOwner: toAutomationOwnerPrecondition(selector) }
            : {})
        })
        if (
          at !== scope.current ||
          id !== request.current ||
          generation !== client.getGeneration?.()
        ) {
          return
        }
        const page = automationRunsRead.interpret(reply)
        const keepOlder = !next && paged.current
        setRuns((previous) =>
          next
            ? [
                ...previous,
                ...page.runs.filter((run) => !previous.some((old) => old.id === run.id))
              ]
            : keepOlder
              ? [
                  ...page.runs,
                  ...previous.filter((old) => !page.runs.some((run) => run.id === old.id))
                ]
              : page.runs
        )
        if (!keepOlder) {
          setCursor(page.nextCursor ?? null)
        }
        if (next) {
          paged.current = true
        }
        setError(null)
      } catch (failure) {
        if (at === scope.current) {
          setError(automationErrorMessage(failure))
        }
      } finally {
        if (at === scope.current) {
          lock.current = false
          setLoading(false)
          if (refreshPending.current) {
            refreshPending.current = false
            void readPage()
          }
        }
      }
    },
    [client, filterId, ownerKey]
  )
  useEffect(() => {
    scope.current++
    lock.current = false
    setRuns([])
    setCursor(null)
    paged.current = false
    refreshPending.current = false
    return () => {
      scope.current++
      lock.current = false
    }
  }, [load])
  useEffect(() => {
    if (connected) {
      void load()
    } else {
      scope.current++
      lock.current = false
      refreshPending.current = false
    }
  }, [load, revision, connected])
  return {
    runs,
    cursor,
    loading: connected && loading,
    error,
    loadMore: () => {
      if (cursor) {
        void load(cursor)
      }
    },
    reload: () => void load()
  }
}
