import type { FollowUpAction } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpStore } from './store'
import type { CrewRecordAuthority } from '../runtime/orchestration/crew/crew-changes'

export type FollowUpActivityAuthority = CrewRecordAuthority & { readonly instanceId?: string }

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
          if ((map === this.instances || map === this.workspaces) && value.status === 'accepted') {
            continue
          }
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

  keys(authorities: readonly FollowUpActivityAuthority[]): string[] {
    const keys = new Set<string>()
    const add = (matches: Iterable<string>) => {
      for (const key of matches) {
        keys.add(this.actions.get(key)!.prKey)
      }
    }
    for (const entry of authorities) {
      const precise = new Set(this.identities.get(entry.recordId ?? ''))
      for (const id of entry.operationIds ?? []) {
        for (const key of this.operations.get(id) ?? []) {
          precise.add(key)
        }
      }
      if (precise.size) {
        add(precise)
      } else {
        add(this.instances.get(entry.instanceId ?? '') ?? [])
        for (const workspace of entry.workspaceIds ?? []) {
          add(this.workspaces.get(workspace) ?? [])
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
    const obligations = new Set([
      ...(this.identities.get(identity) ?? []),
      ...(this.workspaces.get(worktreeId) ?? [])
    ])
    for (const key of obligations) {
      const action = this.actions.get(key)!
      owners.add(action.instanceId)
    }
    for (const owner of owners) {
      this.store.appendActivity(owner, identity, kind, at)
    }
    // Capture includes unresolved owners; a known stream only reevaluates its precise obligations.
    return this.keys([{ recordId: identity, workspaceIds: [worktreeId] }])
  }
}
