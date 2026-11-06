import type { FollowUpAction } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpStore } from './store'

export type FollowUpActivityKind = 'started' | 'working' | 'idle' | 'unknown' | 'terminated'
export type FollowUpActivity = { at: number; kind: FollowUpActivityKind }
export const followUpActivityIdentity = (action: FollowUpAction): string =>
  action.paneKey ?? action.sessionId ?? action.terminalPtyId ?? action.operationId

// Unknown preserves established work; only positive idle or termination closes it.
export function activityOverlaps(
  events: readonly FollowUpActivity[],
  from: number,
  to: number
): boolean {
  let working = false
  for (const event of events) {
    if (event.at > to) {
      break
    }
    if (working && event.at >= from) {
      return true
    }
    if (event.kind !== 'unknown') {
      working = event.kind === 'started' || event.kind === 'working'
    }
  }
  return working
}

const pending = (a: FollowUpAction): boolean =>
  (a.status === 'accepted' && a.sessionEndedAt === undefined) ||
  (['claimed', 'unconfirmed'].includes(a.status) && a.recoveryFinalizedAt === undefined)

// Admission authority belongs to durable obligations, independently of display projections.
export class FollowUpActivityRouter {
  private readonly actions = new Map<string, FollowUpAction>()
  private readonly instances = new Map<string, Set<string>>()
  private readonly workspaces = new Map<string, Set<string>>()
  private readonly identities = new Map<string, Set<string>>()
  private readonly operations = new Map<string, Set<string>>()
  constructor(private readonly store: FollowUpStore) {
    for (const action of store.pendingActions()) {
      this.committed(action)
    }
  }

  committed(action: FollowUpAction): void {
    const old = this.actions.get(action.actionKey)
    const index = (value: FollowUpAction, add: boolean) => {
      for (const [map, ids] of [
        [this.instances, [value.instanceId]],
        [this.workspaces, [value.worktreeId]],
        [this.identities, [value.sessionId, value.paneKey, value.terminalPtyId]],
        [this.operations, [value.operationId]]
      ] as const) {
        for (const id of ids) {
          if (!id) {
            continue
          }
          const keys = map.get(id) ?? new Set<string>()
          if (add) {
            keys.add(value.actionKey)
            map.set(id, keys)
          } else {
            keys.delete(value.actionKey)
            if (!keys.size) {
              map.delete(id)
            }
          }
        }
      }
    }
    if (old) {
      index(old, false)
    }
    this.actions.delete(action.actionKey)
    if (pending(action)) {
      this.actions.set(action.actionKey, { ...action })
      index(action, true)
    }
  }

  keys(
    identities: readonly string[] = [],
    instances: readonly string[] = [],
    operations: readonly string[] = [],
    workspaces: readonly string[] = []
  ): string[] {
    const keys = new Set<string>()
    for (const [map, ids] of [
      [this.identities, identities],
      [this.instances, instances],
      [this.operations, operations],
      [this.workspaces, workspaces]
    ] as const) {
      for (const id of ids) {
        for (const key of map.get(id) ?? []) {
          keys.add(this.actions.get(key)!.prKey)
        }
      }
    }
    return [...keys]
  }

  activeKeys(): string[] {
    return [...new Set([...this.actions.values()].map((a) => a.prKey))]
  }

  admit(worktreeId: string, identity: string, kind: FollowUpActivityKind, at: number): string[] {
    const owners = new Set<string>()
    // Identity retains its original instance even after its workspace is removed or replaced.
    for (const key of this.identities.get(identity) ?? []) {
      owners.add(this.actions.get(key)!.instanceId)
    }
    for (const key of this.workspaces.get(worktreeId) ?? []) {
      const action = this.actions.get(key)!
      if (
        action.status !== 'accepted' ||
        [action.sessionId, action.paneKey, action.terminalPtyId].includes(identity)
      ) {
        owners.add(action.instanceId)
      }
    }
    for (const owner of owners) {
      this.store.appendActivity(owner, identity, kind, at)
    }
    return this.keys([], [...owners])
  }
}
