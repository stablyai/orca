import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

export type SshPtyLeaseOperations = {
  state: StoreOwnedPersistedState
  toStoredPtyId: (targetId: string, ptyId: string) => string
  clearBindingsForTarget: (targetId: string) => void
  clearBindingsForLeases: (targetId: string, leases: SshRemotePtyLease[]) => boolean
  flush: () => void
  flushDurableStateOrThrowAsync: () => Promise<void>
}

export function getSshRemotePtyLeases(
  state: PersistedState,
  targetId?: string
): SshRemotePtyLease[] {
  const leases = state.sshRemotePtyLeases ?? []
  return leases.filter((lease) => targetId === undefined || lease.targetId === targetId)
}

export function upsertSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  lease: Omit<SshRemotePtyLease, 'createdAt' | 'updatedAt'> &
    Partial<Pick<SshRemotePtyLease, 'createdAt' | 'updatedAt'>>
): void {
  operations.state.sshRemotePtyLeases ??= []
  const normalizedLease = { ...lease }
  if (normalizedLease.leafId !== undefined && !isTerminalLeafId(normalizedLease.leafId)) {
    delete normalizedLease.leafId
  }
  // Why: store target-local pty ids in leases so reconnect can call relay pty.attach with raw ids (app ids are global).
  normalizedLease.ptyId = operations.toStoredPtyId(normalizedLease.targetId, normalizedLease.ptyId)
  const now = Date.now()
  const existingIndex = operations.state.sshRemotePtyLeases.findIndex(
    (entry) => entry.targetId === normalizedLease.targetId && entry.ptyId === normalizedLease.ptyId
  )
  const existing =
    existingIndex !== -1 ? operations.state.sshRemotePtyLeases[existingIndex] : undefined
  // Why: callers pass optional fields as explicit `undefined`, which would blank the stored tabId/leafId
  // (and friends) when re-upserting an existing lease.
  const definedLease = Object.fromEntries(
    Object.entries(normalizedLease).filter(([, value]) => value !== undefined)
  ) as typeof normalizedLease
  const next: SshRemotePtyLease = {
    ...existing,
    ...definedLease,
    createdAt: existing?.createdAt ?? normalizedLease.createdAt ?? now,
    updatedAt: normalizedLease.updatedAt ?? now
  }
  if (existingIndex !== -1) {
    operations.state.sshRemotePtyLeases[existingIndex] = next
  } else {
    operations.state.sshRemotePtyLeases.push(next)
  }
  operations.flush()
}

function updateSshRemotePtyLeaseStates(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state'],
  ptyIds?: ReadonlySet<string>
): boolean {
  const now = Date.now()
  let changed = false
  const shouldClearBindings = state === 'terminated' || state === 'expired'
  const leasesToClear: SshRemotePtyLease[] = []
  operations.state.sshRemotePtyLeases ??= []
  for (const lease of operations.state.sshRemotePtyLeases) {
    if (lease.targetId !== targetId || (ptyIds && !ptyIds.has(lease.ptyId))) {
      continue
    }
    if (state === 'attached' && (lease.state === 'terminated' || lease.state === 'expired')) {
      continue
    }
    if (state === 'detached' && lease.state !== 'attached') {
      continue
    }
    if (lease.state !== state) {
      lease.state = state
      lease.updatedAt = now
      if (state === 'attached') {
        lease.lastAttachedAt = now
      } else if (state === 'detached') {
        lease.lastDetachedAt = now
      }
      changed = true
    }
    if (shouldClearBindings) {
      leasesToClear.push(lease)
    }
  }
  const bindingsChanged = shouldClearBindings
    ? operations.clearBindingsForLeases(targetId, leasesToClear)
    : false
  return changed || bindingsChanged
}

export function markSshRemotePtyLeases(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): void {
  if (updateSshRemotePtyLeaseStates(operations, targetId, state)) {
    operations.flush()
  }
}

// Why no write of its own: the committed quit path calls this immediately before the final store
// flush, and that flush is what persists it. A durable write here would race the flush and be
// rejected the moment it latches, which is exactly how an attached lease used to survive quit.
export function markSshRemotePtyLeasesForShutdown(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): void {
  updateSshRemotePtyLeaseStates(operations, targetId, state)
}

export async function markSshRemotePtyLeasesAsync(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): Promise<void> {
  if (updateSshRemotePtyLeaseStates(operations, targetId, state)) {
    await operations.flushDurableStateOrThrowAsync()
  }
}

export async function markSshRemotePtyLeasesAttachedAsync(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyIds: readonly string[]
): Promise<void> {
  const relayPtyIds = new Set(ptyIds.map((ptyId) => operations.toStoredPtyId(targetId, ptyId)))
  if (updateSshRemotePtyLeaseStates(operations, targetId, 'attached', relayPtyIds)) {
    await operations.flushDurableStateOrThrowAsync()
  }
}

export function markSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  state: SshRemotePtyLease['state']
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = operations.state.sshRemotePtyLeases?.find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease) {
    return
  }
  const shouldClearBindings = state === 'terminated' || state === 'expired'
  if (lease.state === state) {
    if (shouldClearBindings && operations.clearBindingsForLeases(targetId, [lease])) {
      operations.flush()
    }
    return
  }
  const now = Date.now()
  lease.state = state
  lease.updatedAt = now
  if (state === 'attached') {
    lease.lastAttachedAt = now
  } else if (state === 'detached') {
    lease.lastDetachedAt = now
  }
  if (shouldClearBindings) {
    operations.clearBindingsForLeases(targetId, [lease])
  }
  operations.flush()
}

export function removeSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const leases = (operations.state.sshRemotePtyLeases ?? []).filter(
    (lease) => lease.targetId === targetId && lease.ptyId === relayPtyId
  )
  const before = operations.state.sshRemotePtyLeases?.length ?? 0
  operations.clearBindingsForLeases(targetId, leases)
  operations.state.sshRemotePtyLeases = (operations.state.sshRemotePtyLeases ?? []).filter(
    (lease) => lease.targetId !== targetId || lease.ptyId !== relayPtyId
  )
  if (operations.state.sshRemotePtyLeases.length !== before) {
    operations.flush()
  }
}

export function removeSshRemotePtyLeases(
  operations: SshPtyLeaseOperations,
  targetId: string
): void {
  operations.state.sshRemotePtyLeases ??= []
  operations.clearBindingsForTarget(targetId)
  const before = operations.state.sshRemotePtyLeases.length
  operations.state.sshRemotePtyLeases = operations.state.sshRemotePtyLeases.filter(
    (lease) => lease.targetId !== targetId
  )
  if (operations.state.sshRemotePtyLeases.length !== before) {
    operations.flush()
  }
}
