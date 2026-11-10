import type { RemoteLayoutSnapshot } from '../../../shared/remote-layout-snapshot'
import type { ProfileStateDomainPartsUpdate } from './profile-state-authority'
import { serializeSelectiveProfileStateDomains } from './profile-state-authority-writes'

export type PendingRemoteLayoutWorkspaces = Map<string, Set<string> | null>

export function serializeRemoteLayoutSnapshotParts(
  snapshots: Record<string, RemoteLayoutSnapshot> | undefined,
  pending: PendingRemoteLayoutWorkspaces
): ProfileStateDomainPartsUpdate | undefined {
  if (pending.size === 0 || snapshots === undefined) {
    return undefined
  }
  const order: string[] = []
  const parts: { key: string; payload: string }[] = []
  for (const [environment, snapshot] of Object.entries(snapshots)) {
    if (
      !snapshot ||
      Object.keys(snapshot).length !== 1 ||
      !snapshot.workspaces ||
      typeof snapshot.workspaces !== 'object' ||
      Array.isArray(snapshot.workspaces)
    ) {
      return undefined
    }
    const keys = Object.keys(snapshot.workspaces)
    const dirty = pending.get(environment)
    if (keys.length === 0) {
      const key = JSON.stringify([environment, 'workspaces'])
      order.push(key)
      if (pending.has(environment)) {
        parts.push({ key, payload: '{}' })
      }
    }
    for (const worktree of keys) {
      const key = JSON.stringify([environment, 'workspaces', worktree])
      order.push(key)
      if (dirty === null || dirty?.has(worktree)) {
        const [replacement] = serializeSelectiveProfileStateDomains(
          { [worktree]: snapshot.workspaces[worktree] },
          new Set([worktree])
        )
        if (replacement?.payload == null) {
          return undefined
        }
        parts.push({ key, payload: replacement.payload })
      }
    }
  }
  if (order.length === 0) {
    order.push('[]')
    parts.push({ key: '[]', payload: '{}' })
  }
  return { domain: 'remoteLayoutSnapshots', order, parts }
}

export function restoreRemoteLayoutWorkspaces(
  pending: PendingRemoteLayoutWorkspaces,
  captured: PendingRemoteLayoutWorkspaces
): void {
  for (const [environment, keys] of captured) {
    const current = pending.get(environment)
    pending.set(
      environment,
      keys === null || current === null ? null : new Set([...keys, ...(current ?? [])])
    )
  }
}
