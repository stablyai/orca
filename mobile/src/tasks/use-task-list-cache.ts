import { hashKey, skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type HostQueryKey, type HostQueryParams, hostScopeKey } from '../query/host-query-key'
import { persistedHostQueryKey, restoreStoredHostQueries } from '../query/host-query-persistence'
import { taskListQuery, type TaskListSnapshot } from './task-queries'
import {
  taskLastListKey,
  taskLastListStorage,
  taskListKey,
  taskListStorage
} from './task-query-storage'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'

type TaskListView = Pick<
  ProviderLoadActionsModel,
  | 'hostId'
  | 'items'
  | 'jiraConnection'
  | 'provider'
  | 'setError'
  | 'setItems'
  | 'setGithubPages'
  | 'setGithubCurrentPage'
  | 'setGithubRepoSources'
  | 'setGithubSourceErrors'
  | 'setGithubSourceFallbacks'
  | 'setGithubCountedTotalPages'
  | 'setLoading'
  | 'setTaskListSettled'
  | 'taskUiReady'
>

// Drawn by the screen, never fetched; the meta makes the write-behind keep it.
const LAST_LIST_META = { streamBacked: true, persist: taskLastListStorage.persist }

/** The lists each filter read last, and which of them a read in flight is standing on. */
export function useTaskListCache(view: TaskListView) {
  const queryClient = useQueryClient()
  const { hostId, provider, taskUiReady } = view
  const jiraSelection = view.jiraConnection.selection
  // Set while kept rows stand in for a read in flight; drives the header's refresh line, not the list spinner.
  const [revalidating, setRevalidating] = useState(false)
  // When the rows on screen were read from the host, possibly at an earlier launch.
  const [rowsReadAt, setRowsReadAt] = useState<number | null>(null)
  // The provider whose rows are on screen, so a provider switch never keeps another provider's rows.
  const shownProviderRef = useRef<string | null>(null)
  // The list the rows on screen were read for; only a re-read of that same list may stand on them.
  const shownListRef = useRef<string | null>(null)
  const shownRowsRef = useRef(view.items)
  useLayoutEffect(() => {
    shownRowsRef.current = view.items
  }, [view.items])
  // The stored list a read or the not-yet-ready screen is waiting on; any later begin or settle drops it.
  const awaitingStoredRef = useRef<object | null>(null)
  const { data: lastList } = useQuery<HostQueryParams>({
    queryKey: taskLastListKey(hostId, provider),
    queryFn: skipToken,
    meta: LAST_LIST_META
  })

  // The list's notice and the refresh line belong to a read; the not-ready screen has none out, so draws rows only.
  const paintRows = useCallback(
    (key: HostQueryKey, kept: TaskListSnapshot, provider: string, underRead: boolean): void => {
      shownProviderRef.current = provider
      shownListRef.current = hashKey(key)
      setRowsReadAt(queryClient.getQueryState(key)?.dataUpdatedAt || null)
      view.setItems(kept.items)
      if (underRead) {
        view.setError(kept.notice ?? '')
      }
      if (kept.github) {
        const { sources } = kept.github
        view.setGithubRepoSources((current) => ({ ...current, ...sources }))
        view.setGithubPages([kept.items])
        view.setGithubCurrentPage(0)
        view.setGithubSourceErrors(kept.github.sourceErrors)
        view.setGithubSourceFallbacks(kept.github.sourceFallbacks)
        view.setGithubCountedTotalPages(kept.github.countedTotalPages)
      }
      view.setTaskListSettled(true)
      if (underRead) {
        setRevalidating(true)
      }
    },
    [queryClient]
  )

  // Calls `paint` with a list an earlier launch stored once the phone's store answers, unless something else landed first.
  const whenStored = useCallback(
    (key: HostQueryKey, paint: (snapshot: TaskListSnapshot) => void): object => {
      const awaiting = {}
      awaitingStoredRef.current = awaiting
      const stored = persistedHostQueryKey(taskListStorage, key)
      void restoreStoredHostQueries(queryClient, stored ? [stored] : [])
        .catch(() => {})
        .then(() => {
          const snapshot = queryClient.getQueryData<TaskListSnapshot>(key)
          if (awaitingStoredRef.current === awaiting && snapshot) {
            awaitingStoredRef.current = null
            paint(snapshot)
          }
        })
      return awaiting
    },
    [queryClient]
  )

  // Until Tasks is ready (connecting, offline, or waiting on its first read), the screen shows the list it showed last.
  useEffect(() => {
    // A Jira list is one site's; the site chip comes from the Jira status, which a pick on the phone doesn't change.
    const jiraSiteShown = lastList?.provider !== 'jira' || lastList.site === (jiraSelection ?? null)
    if (taskUiReady || !lastList || !jiraSiteShown) {
      return
    }
    const key = taskListKey(hostId, lastList)
    const awaiting = whenStored(key, (snapshot) => {
      // Rows this document read stay; another provider's rows give way.
      if (shownRowsRef.current.length === 0 || shownProviderRef.current !== provider) {
        paintRows(key, snapshot, provider, false)
      }
    })
    // A provider or host this screen has left no longer wants that list.
    return () => {
      if (awaitingStoredRef.current === awaiting) {
        awaitingStoredRef.current = null
      }
    }
  }, [hostId, jiraSelection, lastList, paintRows, provider, taskUiReady, whenStored])

  // Stops a replaced or abandoned read before its next repo; the kept rows stay as they were.
  const cancelRead = useCallback((): void => {
    void queryClient.cancelQueries(
      { queryKey: [...hostScopeKey(hostId), taskListQuery.family], fetchStatus: 'fetching' },
      { silent: true }
    )
  }, [hostId, queryClient])

  // A read of a list starts on that filter's kept rows, else on its own rows still shown, else the spinner, so another
  // filter's rows never sit under a new search; it is also the list this provider opens on next launch.
  const begin = useCallback(
    (params: HostQueryParams | null, provider: string): void => {
      cancelRead()
      awaitingStoredRef.current = null
      const key = params && taskListKey(hostId, params)
      if (params) {
        queryClient.setQueryData(taskLastListKey(hostId, provider), params)
      }
      const kept = key ? queryClient.getQueryData<TaskListSnapshot>(key) : undefined
      if (kept && key) {
        paintRows(key, kept, provider, true)
        return
      }
      if (
        shownRowsRef.current.length > 0 &&
        shownProviderRef.current === provider &&
        (!key || shownListRef.current === hashKey(key))
      ) {
        setRevalidating(true)
      } else {
        view.setLoading(true)
      }
      if (key) {
        whenStored(key, (snapshot) => {
          view.setLoading(false)
          paintRows(key, snapshot, provider, true)
        })
      }
    },
    [cancelRead, hostId, paintRows, queryClient, whenStored]
  )
  // A read landed and its rows are on screen.
  const shown = useCallback(
    (provider: string, params: HostQueryParams): void => {
      awaitingStoredRef.current = null
      shownProviderRef.current = provider
      const key = taskListKey(hostId, params)
      shownListRef.current = hashKey(key)
      setRowsReadAt(queryClient.getQueryState(key)?.dataUpdatedAt || null)
    },
    [hostId, queryClient]
  )
  const settle = useCallback((): void => {
    awaitingStoredRef.current = null
    setRevalidating(false)
  }, [])
  // The GitHub page count lands after the rows; keep it with them.
  const rememberPageCount = useCallback(
    (key: HostQueryKey | null, countedTotalPages: number): void => {
      if (key) {
        queryClient.setQueryData<TaskListSnapshot>(
          key,
          (snapshot) =>
            snapshot?.github && { ...snapshot, github: { ...snapshot.github, countedTotalPages } }
        )
      }
    },
    [queryClient]
  )
  return { revalidating, rowsReadAt, begin, shown, settle, cancelRead, rememberPageCount }
}
