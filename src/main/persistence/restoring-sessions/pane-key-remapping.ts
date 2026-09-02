import type { PersistedState } from '../../../shared/persisted-state-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

type PaneLeafRemap = Map<string, Map<string, string>>

function remapPaneKeys<T extends number>(
  values: Record<string, T> | undefined,
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { values: Record<string, T> | undefined; changed: boolean } {
  if (!values || Object.keys(values).length === 0) {
    return { values, changed: false }
  }

  let changed = false
  const next: Record<string, T> = {}
  const setValue = (paneKey: string, value: T): void => {
    const existing = next[paneKey]
    next[paneKey] = existing === undefined ? value : (Math.max(existing, value) as T)
  }
  for (const [paneKey, value] of Object.entries(values)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      setValue(paneKey, value)
      continue
    }

    const delimiter = paneKey.indexOf(':')
    if (delimiter <= 0 || delimiter === paneKey.length - 1) {
      setValue(paneKey, value)
      continue
    }

    const tabId = paneKey.slice(0, delimiter)
    const legacyLeafId = paneKey.slice(delimiter + 1)
    const remappedLeafId = leafIdByInputLeafIdByTabId.get(tabId)?.get(legacyLeafId)
    if (!remappedLeafId || !isTerminalLeafId(remappedLeafId)) {
      setValue(paneKey, value)
      continue
    }

    try {
      // Carry values over when a legacy leaf is promoted to a UUID.
      setValue(makePaneKey(tabId, remappedLeafId), value)
      changed = true
    } catch {
      setValue(paneKey, value)
    }
  }

  return { values: next, changed }
}

export function remapAcknowledgedAgentPaneKeys(
  acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey'],
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { acknowledgements: PersistedState['ui']['acknowledgedAgentsByPaneKey']; changed: boolean } {
  const result = remapPaneKeys(acknowledgements, leafIdByInputLeafIdByTabId)
  return { acknowledgements: result.values, changed: result.changed }
}

export function remapManuallyUnreadTurnPaneKeys(
  turns: PersistedState['ui']['manuallyUnreadTurnsByPaneKey'],
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { turns: PersistedState['ui']['manuallyUnreadTurnsByPaneKey']; changed: boolean } {
  const result = remapPaneKeys(turns, leafIdByInputLeafIdByTabId)
  return { turns: result.values, changed: result.changed }
}

export function remapActivityClearedAtPaneKeys(
  cutoffs: PersistedState['ui']['activityClearedAtByPaneKey'],
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { cutoffs: PersistedState['ui']['activityClearedAtByPaneKey']; changed: boolean } {
  const result = remapPaneKeys(cutoffs, leafIdByInputLeafIdByTabId)
  return { cutoffs: result.values, changed: result.changed }
}
