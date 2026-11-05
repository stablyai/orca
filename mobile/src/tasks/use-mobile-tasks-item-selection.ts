import { useCallback, useReducer, type SetStateAction } from 'react'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'

type ItemUpdate = SetStateAction<ActionableTaskItem | null>
type ItemSelection = {
  actionItem: ActionableTaskItem | null
  detailRequestItem: ActionableTaskItem | null
}

function updateItemSelection(
  current: ItemSelection,
  action: { kind: 'action' | 'hydrate'; update: ItemUpdate }
): ItemSelection {
  const actionItem =
    typeof action.update === 'function' ? action.update(current.actionItem) : action.update
  if (actionItem === current.actionItem) {
    return current
  }
  return {
    actionItem,
    detailRequestItem: action.kind === 'hydrate' ? current.detailRequestItem : actionItem
  }
}

export function useMobileTasksItemSelection() {
  const [selection, dispatch] = useReducer(updateItemSelection, {
    actionItem: null,
    detailRequestItem: null
  })
  const setActionItem = useCallback((update: ItemUpdate) => {
    dispatch({ kind: 'action', update })
  }, [])
  const hydrateActionItem = useCallback((update: ItemUpdate) => {
    dispatch({ kind: 'hydrate', update })
  }, [])
  return { ...selection, setActionItem, hydrateActionItem }
}
