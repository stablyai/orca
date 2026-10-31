import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { AutomationOwnerPrecondition } from '../../../src/shared/automation-owner-precondition'
import { compareAutomationRunsNewestFirst } from '../../../src/shared/automation-run-cursor'
import { automationRunsRead } from './automation-operations'
import { automationErrorMessage } from './automation-error'
import type { MobileAutomationRun } from './automation-reply-schema'

export type AutomationRunScope = {
  automationId: string
  expectedOwner: AutomationOwnerPrecondition
} | null
const GLOBAL_SCOPE = 'global'
type History = { ids: string[]; cursor: string | null; loaded: boolean; selectionId?: string }

export function useAutomationRuns(
  client: RpcClient | null,
  query: AutomationRunScope,
  revision: number,
  connected: boolean,
  selected?: MobileAutomationRun,
  observing = true
) {
  const records = useRef(new Map<string, MobileAutomationRun>())
  const histories = useRef(new Map<string, History>())
  const [, render] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const lock = useRef(false)
  const pending = useRef(false)
  const key = query ? JSON.stringify(query) : GLOBAL_SCOPE
  const observation = useRef(observing)
  const scope = useRef(query)
  const selection = useRef(selected)
  const history: History = histories.current.get(key) ?? { ids: [], cursor: null, loaded: false }
  useLayoutEffect(() => {
    observation.current = observing
    scope.current = query
    selection.current = selected
    histories.current.set(key, history)
    if (selected && !records.current.has(selected.id)) {
      records.current.set(selected.id, selected)
    }
  })

  const load = useCallback(
    async function read(next?: string): Promise<void> {
      if (!observation.current || !client || client.getState() !== 'connected') {
        return
      }
      if (lock.current) {
        if (!next) {
          pending.current = true
        }
        return
      }
      lock.current = true
      setLoading(true)
      const at = epoch.current
      const generation = client.getGeneration?.()
      const requestScope = scope.current
      const selectedRun = selection.current
      const current = () =>
        at === epoch.current &&
        generation === client.getGeneration?.() &&
        client.getState() === 'connected'
      const state: History = histories.current.get(key) ?? { ids: [], cursor: null, loaded: false }
      const oldest = state.ids.at(-1)
      const boundaries = [oldest ? records.current.get(oldest) : undefined, selectedRun].filter(
        (run): run is MobileAutomationRun => !!run
      )
      const boundary = boundaries.sort(compareAutomationRunsNewestFirst).at(-1)
      const ids = new Set(next ? state.ids : [])
      let cursor = next
      try {
        for (;;) {
          if (!observation.current) {
            return
          }
          const reply = await automationRunsRead.request(client, {
            limit: 30,
            ...requestScope,
            ...(cursor ? { cursor } : {})
          })
          if (!current()) {
            return
          }
          const page = automationRunsRead.interpret(reply)
          for (const run of page.runs) {
            records.current.set(run.id, run)
            ids.add(run.id)
          }
          render((value) => value + 1)
          cursor = page.nextCursor ?? undefined
          const last = page.runs.at(-1)
          if (
            next ||
            !cursor ||
            !boundary ||
            (last && compareAutomationRunsNewestFirst(last, boundary) >= 0)
          ) {
            break
          }
        }
        histories.current.set(key, {
          ids: [...ids],
          cursor: cursor ?? null,
          loaded: true,
          selectionId: selectedRun?.id
        })
        const retained = new Set([...histories.current.values()].flatMap((entry) => entry.ids))
        if (selection.current) {
          retained.add(selection.current.id)
        }
        for (const id of records.current.keys()) {
          if (!retained.has(id)) {
            records.current.delete(id)
          }
        }
        setError(null)
      } catch (failure) {
        if (current()) {
          setError(automationErrorMessage(failure))
        }
      } finally {
        if (at === epoch.current) {
          lock.current = false
          setLoading(false)
          render((value) => value + 1)
          if (pending.current) {
            pending.current = false
            void read()
          }
        }
      }
    },
    [client, key]
  )
  useEffect(() => {
    epoch.current++
    lock.current = false
    pending.current = false
    setError(null)
    return () => {
      epoch.current++
      lock.current = false
    }
  }, [client, key, connected])
  useEffect(() => {
    if (connected && observing) {
      void load()
    }
  }, [load, connected, observing, revision, selected?.id])
  return {
    runs: history.ids.flatMap((id) => {
      const run = records.current.get(id)
      return run ? [run] : []
    }),
    selected: selected ? (records.current.get(selected.id) ?? selected) : undefined,
    unavailable:
      !!selected &&
      !loading &&
      !error &&
      history.loaded &&
      history.selectionId === selected.id &&
      !history.ids.includes(selected.id),
    cursor: history.cursor,
    loading: connected && loading,
    error,
    loadMore: () => {
      if (history.cursor) {
        void load(history.cursor)
      }
    },
    reload: () => void load()
  }
}
export type AutomationRunObservation = ReturnType<typeof useAutomationRuns>
