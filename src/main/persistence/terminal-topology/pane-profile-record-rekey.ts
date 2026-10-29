import { sessionBindingIndex } from '../loading-store/session-binding-index'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { makePaneKey } from '../../../shared/stable-pane-id'

export function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string | null,
  remap: (value: T) => T = (value) => value,
  /** Preserve existing destination values on collision. */
  keepTarget = false
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (toKey !== null && value !== undefined && !(keepTarget && Object.hasOwn(next, toKey))) {
    next[toKey] = remap(value)
  }
  return next
}

export function rekeyPaneProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  from: PaneAddress,
  to: PaneAddress
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const fromPaneKey = makePaneKey(from.tabId, from.leafId)
  const toPaneKey = makePaneKey(to.tabId, to.leafId)
  const ui = state.ui
  let nextUi: PersistedState['ui'] | undefined
  for (const key of PANE_KEYED_UI_RECORDS) {
    const moved = moveRecordKey(ui?.[key], fromPaneKey, toPaneKey)
    if (ui && moved !== ui[key]) {
      nextUi = { ...(nextUi ?? ui), [key]: moved }
    }
  }
  const leases = state.sshRemotePtyLeases ?? []
  let nextLeases = leases
  for (const position of sessionBindingIndex(leases).positionsByTab.get(from.tabId) ?? []) {
    const lease = leases[position]
    if (lease.leafId !== from.leafId) {
      continue
    }
    if (nextLeases === leases) {
      nextLeases = [...leases]
    }
    nextLeases[position] = { ...lease, tabId: to.tabId, leafId: to.leafId }
  }
  return {
    ...(nextUi ? { ui: nextUi } : {}),
    ...(nextLeases !== leases ? { sshRemotePtyLeases: nextLeases } : {})
  }
}

const PANE_KEYED_UI_RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const
type PaneAddress = { tabId: string; leafId: string }
