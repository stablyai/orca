import { useCallback, useMemo } from 'react'
import { hashKey, skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import * as z from 'zod'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { hostQueryKey } from '../../query/host-query-key'
import type { PersistedHostFamily } from '../../query/host-query-persistence'
import type { MobileSessionTab } from './mobile-session-tabs'

const storedTabSchema = z.looseObject({ type: z.string(), id: z.string(), title: z.string() })

/** Agent dots come only from the host's live snapshot (K1), so a stored strip carries no agent state. */
function withoutAgentState(tab: MobileSessionTab): MobileSessionTab {
  if (tab.type === 'terminal' && tab.agentStatus !== undefined) {
    const { agentStatus: _agentStatus, ...rest } = tab
    return rest
  }
  if (tab.type === 'agent-session' && tab.chatStatus !== undefined) {
    const { chatStatus: _chatStatus, ...rest } = tab
    return rest
  }
  return tab
}

export const sessionTabsFamily: PersistedHostFamily<MobileSessionTab[]> = {
  family: 'session.tabs',
  persist: {
    version: 1,
    dataSchema: z.array(
      z.custom<MobileSessionTab>((tab) => storedTabSchema.safeParse(tab).success)
    ),
    strip: (tabs) => tabs.map(withoutAgentState)
  }
}

export function sessionTabsKey(hostId: string, exec: ExecutionHostId, worktreeId: string) {
  return hostQueryKey(hostId, sessionTabsFamily.family, { exec, worktree: worktreeId }, {})
}

const LAST_TABS_META = { streamBacked: true, persist: sessionTabsFamily.persist }

/** When the remembered strip was last accepted, possibly at an earlier launch; null with none. */
export function useLastSessionTabsAt(hostId: string, worktreeId: string): number | null {
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const key = useMemo(() => sessionTabsKey(hostId, exec, worktreeId), [hostId, exec, worktreeId])
  // The same observer options as the strip's own, so neither rewrites the other's.
  const { dataUpdatedAt } = useQuery({
    queryKey: key,
    queryFn: skipToken,
    meta: LAST_TABS_META,
    notifyOnChangeProps: ['dataUpdatedAt']
  })
  return dataUpdatedAt > 0 ? dataUpdatedAt : null
}

// The last strip the host accepted for this workspace, drawn on the next open until the host answers.
export function useMobileSessionLastTabs(hostId: string, worktreeId: string) {
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const key = useMemo(() => sessionTabsKey(hostId, exec, worktreeId), [hostId, exec, worktreeId])
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
    // Calls back each time the remembered strip is set, such as by a store read that lands after mount.
    watchLastSessionTabs: useCallback(
      (listener: (tabs: readonly MobileSessionTab[]) => void) => {
        const queryHash = hashKey(key)
        return queryClient.getQueryCache().subscribe((event) => {
          const tabs = event.query.state.data
          if (
            event.type === 'updated' &&
            event.action.type === 'success' &&
            event.query.queryHash === queryHash &&
            Array.isArray(tabs)
          ) {
            listener(tabs)
          }
        })
      },
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
