import type { SshRemotePtyLease } from '../../../shared/ssh-types'

const indexes = new WeakMap<readonly SshRemotePtyLease[], SessionBindingIndex>()
type SessionBindingIndex = {
  byTarget: ReadonlyMap<string, ReadonlyMap<string, readonly SshRemotePtyLease[]>>
  positionsByTab: ReadonlyMap<string, readonly number[]>
}

/** Lease membership changes replace their array; status-only writes retain the indexed row. */
export function sessionBindingIndex(leases: readonly SshRemotePtyLease[]): SessionBindingIndex {
  const cached = indexes.get(leases)
  if (cached) {
    return cached
  }
  const byTarget = new Map<string, Map<string, SshRemotePtyLease[]>>()
  const positionsByTab = new Map<string, number[]>()
  for (let position = 0; position < leases.length; position++) {
    const lease = leases[position]
    const byPty = byTarget.get(lease.targetId) ?? new Map<string, SshRemotePtyLease[]>()
    byTarget.set(lease.targetId, byPty)
    const rows = byPty.get(lease.ptyId) ?? []
    rows.push(lease)
    byPty.set(lease.ptyId, rows)
    if (lease.tabId) {
      const positions = positionsByTab.get(lease.tabId) ?? []
      positions.push(position)
      positionsByTab.set(lease.tabId, positions)
    }
  }
  const index = { byTarget, positionsByTab }
  indexes.set(leases, index)
  return index
}
