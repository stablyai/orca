import { copySessionRecord } from '../../../shared/session-record-edit'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

type PaneLeafRemap = Map<string, Map<string, string>>

function resolveRemappedPaneKey(
  paneKey: string,
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): string | null {
  if (parsePaneKey(paneKey)) {
    return null
  }
  const delimiter = paneKey.indexOf(':')
  if (delimiter <= 0 || delimiter === paneKey.length - 1) {
    return null
  }
  const tabId = paneKey.slice(0, delimiter)
  const remappedLeafId = leafIdByInputLeafIdByTabId.get(tabId)?.get(paneKey.slice(delimiter + 1))
  // makePaneKey cannot throw here: tabId is non-empty and colon-free by construction.
  return remappedLeafId && isTerminalLeafId(remappedLeafId)
    ? makePaneKey(tabId, remappedLeafId)
    : null
}

function remapPaneKeys<T extends number>(
  values: Record<string, T> | undefined,
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { values: Record<string, T> | undefined; changed: boolean } {
  if (!values) {
    return { values, changed: false }
  }
  let next = values
  for (const [tabId, remaps] of leafIdByInputLeafIdByTabId) {
    for (const input of remaps.keys()) {
      const paneKey = `${tabId}:${input}`
      const target = resolveRemappedPaneKey(paneKey, leafIdByInputLeafIdByTabId)
      if (!target || !Object.hasOwn(values, paneKey)) {
        continue
      }
      if (next === values) {
        next = copySessionRecord(values)
      }
      const value = values[paneKey]
      const existing = next[target]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generic values are numeric pane timestamps; Math.max preserves that value type.
      next[target] = (existing === undefined ? value : Math.max(existing, value)) as T
      delete next[paneKey]
    }
  }
  return { values: next, changed: next !== values }
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
