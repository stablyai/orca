import { useCallback } from 'react'
import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import * as z from 'zod'
import { hostQueryKey } from '../../query/host-query-key'
import type { PersistedHostFamily } from '../../query/host-query-persistence'
import type { MobileViewState } from '../../worktree/workspace-view-settings'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../catalog/host-list-queries'

const storedViewSchema = z.looseObject({
  groupBy: z.string(),
  sortBy: z.string(),
  filters: z.looseObject({}),
  collapsedGroups: z.array(z.string()),
  workspaceStatuses: z.array(z.looseObject({})),
  worktreeCardProperties: z.array(z.string())
})

/** The Workspace options the list last drew for a host, so stored rows paint grouped and sorted as before. */
export const hostViewFamily: PersistedHostFamily<MobileViewState> = {
  family: 'ui.workspaceView',
  persist: {
    version: 1,
    dataSchema: z.custom<MobileViewState>((view) => storedViewSchema.safeParse(view).success)
  }
}

export const hostViewKey = (hostId: string) =>
  hostQueryKey(hostId, hostViewFamily.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)

// Kept by the screen that draws it, never fetched: the desktop's reads go through useHostViewSettings.
const HOST_VIEW_META = { streamBacked: true, persist: hostViewFamily.persist }

export function cachedHostView(
  queryClient: QueryClient,
  hostId: string | undefined
): MobileViewState | null {
  return (hostId && queryClient.getQueryData<MobileViewState>(hostViewKey(hostId))) || null
}

/** Holds the host's remembered view while the list is mounted; `remember` records each view it draws. */
export function useHostViewMemory(hostId: string | undefined): (view: MobileViewState) => void {
  const queryClient = useQueryClient()
  const key = hostViewKey(hostId ?? '')
  useQuery({
    queryKey: key,
    queryFn: skipToken,
    meta: HOST_VIEW_META,
    enabled: !!hostId,
    notifyOnChangeProps: []
  })
  return useCallback(
    (view: MobileViewState) => {
      if (hostId) {
        queryClient.setQueryData(hostViewKey(hostId), view)
      }
    },
    [queryClient, hostId]
  )
}
