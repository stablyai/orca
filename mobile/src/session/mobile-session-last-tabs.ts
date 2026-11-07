import { useCallback, useMemo } from 'react'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { hostQueryKey } from '../query/host-query-key'
import type { MobileSessionTab } from './mobile-session-route-types'

const LAST_TABS_META = { streamBacked: true }

// The last strip the host accepted for this workspace, drawn on the next open until the host answers.
export function useMobileSessionLastTabs(hostId: string, worktreeId: string) {
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const key = useMemo(
    () => hostQueryKey(hostId, 'session.tabs', { exec, worktree: worktreeId }, {}),
    [hostId, exec, worktreeId]
  )
  // Never fetched: observing the entry holds it until 10 min after leaving, without re-rendering.
  useQuery({ queryKey: key, queryFn: skipToken, meta: LAST_TABS_META, notifyOnChangeProps: [] })
  return {
    readLastSessionTabs: useCallback(
      () => queryClient.getQueryData<MobileSessionTab[]>(key),
      [queryClient, key]
    ),
    rememberLastSessionTabs: useCallback(
      (tabs: readonly MobileSessionTab[]) =>
        queryClient.setQueryData<MobileSessionTab[]>(key, [...tabs]),
      [queryClient, key]
    ),
    // A tab closed on the phone stays gone on reopen even if the page leaves before the host's next snapshot.
    forgetLastSessionTab: useCallback(
      (tabId: string) =>
        queryClient.setQueryData<MobileSessionTab[]>(key, (cached) =>
          cached?.filter((tab) => tab.id !== tabId)
        ),
      [queryClient, key]
    )
  }
}
