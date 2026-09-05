import type { PersistedState } from '../../../shared/persisted-state-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

type PaneLeafRemap = Map<string, Map<string, string>>

/** Resolves the pane key a legacy entry should move to, or `null` when it stays put. */
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
  const remappedLeafId = leafIdByInputLeafIdByTabId
    .get(paneKey.slice(0, delimiter))
    ?.get(paneKey.slice(delimiter + 1))
  if (!remappedLeafId || !isTerminalLeafId(remappedLeafId)) {
    return null
  }
  try {
    return makePaneKey(paneKey.slice(0, delimiter), remappedLeafId)
  } catch {
    return null
  }
}

function remapPaneKeys<T extends number>(
  values: Record<string, T> | undefined,
  leafIdByInputLeafIdByTabId: PaneLeafRemap
): { values: Record<string, T> | undefined; changed: boolean } {
  if (!values || Object.keys(values).length === 0) {
    return { values, changed: false }
  }

  // Why the classify-first pass: these maps grow with every pane ever opened and this runs on
  // every session write, but post-migration no key is ever rewritten. Rebuilding the whole
  // object only to discard it was pure garbage; the rewrite below is unchanged.
  const requiresRemap = Object.keys(values).some(
    (paneKey) => resolveRemappedPaneKey(paneKey, leafIdByInputLeafIdByTabId) !== null
  )
  if (!requiresRemap) {
    return { values, changed: false }
  }

  const next: Record<string, T> = {}
  for (const [paneKey, value] of Object.entries(values)) {
    // Carry values over when a legacy leaf is promoted to a UUID; keep the max on collision.
    const target = resolveRemappedPaneKey(paneKey, leafIdByInputLeafIdByTabId) ?? paneKey
    const existing = next[target]
    next[target] = existing === undefined ? value : (Math.max(existing, value) as T)
  }
  return { values: next, changed: true }
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
