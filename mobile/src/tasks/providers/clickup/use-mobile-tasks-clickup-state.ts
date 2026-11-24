import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClickUpStatusOption,
  ClickUpTaskListFilter
} from '../../../../../src/shared/clickup/clickup-types'
import type { TaskItem } from '../../mobile-tasks-project-workspace-types'
import { DEFAULT_CLICKUP_FILTER } from './mobile-clickup-filters'
import { useMobileClickUpConnectionState } from './use-mobile-clickup-connection-state'

type KnownStatuses = { scope: string | null; byName: ReadonlyMap<string, ClickUpStatusOption> }

// ClickUp has no workspace-wide status list, so the filter offers the statuses the lists read so far carried.
function useClickUpKnownStatuses(items: readonly TaskItem[], scope: string | null) {
  const [known, setKnown] = useState<KnownStatuses>({ scope, byName: new Map() })
  useEffect(() => {
    const seen = items.flatMap((item) => (item.provider === 'clickup' ? [item.source.status] : []))
    setKnown((current) => {
      const sameScope = current.scope === scope
      const byName = new Map(sameScope ? current.byName : [])
      const grew = seen.reduce((count, status) => {
        if (byName.has(status.name)) {
          return count
        }
        byName.set(status.name, status)
        return count + 1
      }, 0)
      return sameScope && grew === 0 ? current : { scope, byName }
    })
  }, [items, scope])
  return useMemo(
    () =>
      known.scope === scope
        ? [...known.byName.values()].sort((a, b) => a.orderIndex - b.orderIndex)
        : [],
    [known, scope]
  )
}

export function useMobileTasksClickUpState(
  client: unknown,
  connState: string | undefined,
  items: readonly TaskItem[]
) {
  const [clickupConnection, setClickUpConnection] = useMobileClickUpConnectionState(
    client,
    connState
  )
  const clickupStatusRequestIdRef = useRef(0)
  const [clickupFilter, setClickUpFilter] = useState<ClickUpTaskListFilter>(DEFAULT_CLICKUP_FILTER)
  const [showClickUpScopePicker, setShowClickUpScopePicker] = useState(false)
  const [showClickUpWorkspacePicker, setShowClickUpWorkspacePicker] = useState(false)
  const [clickupStatusPickerItem, setClickUpStatusPickerItem] = useState<Extract<
    TaskItem,
    { provider: 'clickup' }
  > | null>(null)
  // Where the host's next page of the open list starts; null when the list is complete or is a search.
  const [clickupNextPage, setClickUpNextPage] = useState<number | null>(null)
  const [clickupLoadingMore, setClickUpLoadingMore] = useState(false)
  const clickupKnownStatuses = useClickUpKnownStatuses(items, clickupConnection.selectedWorkspaceId)
  const closeClickUpOverlays = useCallback(() => {
    setShowClickUpScopePicker(false)
    setShowClickUpWorkspacePicker(false)
    setClickUpStatusPickerItem(null)
  }, [])
  return {
    clickupConnection,
    setClickUpConnection,
    clickupStatusRequestIdRef,
    clickupFilter,
    setClickUpFilter,
    showClickUpScopePicker,
    setShowClickUpScopePicker,
    showClickUpWorkspacePicker,
    setShowClickUpWorkspacePicker,
    clickupStatusPickerItem,
    setClickUpStatusPickerItem,
    clickupNextPage,
    setClickUpNextPage,
    clickupLoadingMore,
    setClickUpLoadingMore,
    clickupKnownStatuses,
    closeClickUpOverlays
  }
}
