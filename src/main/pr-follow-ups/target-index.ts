import type { FollowUpTarget } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineContext } from './engine-contract'
import type { createFollowUpProjectionState } from './projection'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'

export class FollowUpTargetIndex {
  private initialized = false
  private readonly inventoryKeys = new Map<string, string>()
  private readonly groups = new Map<string, Map<string, FollowUpTarget>>()
  readonly byPr = new Map<string, FollowUpTarget[]>()
  readonly byWorkspace = new Map<string, FollowUpTarget>()
  constructor(
    private readonly host: FollowUpEngineContext,
    private readonly state: ReturnType<typeof createFollowUpProjectionState>
  ) {}

  private eligible(target: FollowUpTarget): boolean {
    const settings = resolvePrFollowUps(this.host.globalSettings(), target.settings)
    return (
      !target.archived &&
      settings.enabled &&
      settings.ciFailed === 'new-agent' &&
      target.branch === this.host.observation(target.prKey)?.headRefName
    )
  }

  batch(
    changes: readonly FollowUpTarget[],
    removals: readonly { worktreeId: string; workspaceRemains?: boolean }[] = []
  ): Set<string> {
    const affected = new Set<string>()
    const before = new Map<string, Set<string>>()
    let membership = false
    const touch = (key: string) => {
      if (affected.has(key)) {
        return
      }
      affected.add(key)
      before.set(
        key,
        new Set(
          (this.byPr.get(key) ?? [])
            .map((t) => JSON.parse(this.inventoryKeys.get(t.worktreeId)!) as FollowUpTarget)
            .filter((t) => this.eligible(t))
            .map((t) => t.instanceId)
        )
      )
    }
    const remove = (id: string, remains = false) => {
      const old = this.byWorkspace.get(id)
      if (old) {
        touch(old.prKey)
        this.groups.get(old.prKey)?.delete(id)
      }
      this.byWorkspace.delete(id)
      this.inventoryKeys.delete(id)
      membership = this.state.entries.delete(id) || membership
      if (remains) {
        this.state.entries.set(id, null)
        membership = true
      }
    }
    for (const item of removals) {
      remove(item.worktreeId, item.workspaceRemains)
    }
    for (const target of changes) {
      const fingerprint = JSON.stringify(target)
      if (this.inventoryKeys.get(target.worktreeId) === fingerprint) {
        continue
      }
      const old = this.byWorkspace.get(target.worktreeId)
      // Snapshot each affected group's eligibility before applying any of this batch.
      if (old) {
        touch(old.prKey)
      }
      touch(target.prKey)
      if (old) {
        this.groups.get(old.prKey)?.delete(old.worktreeId)
      }
      const snapshot = target
      const group = this.groups.get(target.prKey) ?? new Map<string, FollowUpTarget>()
      group.set(target.worktreeId, snapshot)
      this.groups.set(target.prKey, group)
      this.byWorkspace.set(target.worktreeId, snapshot)
      this.inventoryKeys.set(target.worktreeId, fingerprint)
      if (!this.state.entries.has(target.worktreeId)) {
        this.state.entries.set(target.worktreeId, null)
        membership = true
      }
    }
    for (const key of affected) {
      const items = [...(this.groups.get(key)?.values() ?? [])]
      if (items.length) {
        this.byPr.set(key, items)
      } else {
        this.byPr.delete(key)
        this.groups.delete(key)
      }
      const eligible = items.filter((t) => this.eligible(t))
      // A surviving eligible instance keeps PR-wide activation through relinks and selection changes.
      if (
        this.initialized &&
        eligible.length &&
        !eligible.some((t) => before.get(key)?.has(t.instanceId))
      ) {
        const pr = this.host.store.pr(key)
        if (pr) {
          pr.needsBaseline = true
          this.host.store.savePr(pr)
        }
      }
    }
    if (membership) {
      this.state.inventoryProjection = JSON.stringify([...this.state.entries.keys()])
    }
    return affected
  }

  refreshInventory(): Set<string> {
    const targets = this.host.targets()
    const ids = new Set(targets.map((t) => t.worktreeId))
    const affected = this.batch(
      targets,
      [...this.byWorkspace.keys()]
        .filter((id) => !ids.has(id))
        .map((worktreeId) => ({ worktreeId }))
    )
    const workspaces = new Set(this.host.workspaceIds())
    for (const id of this.state.entries.keys()) {
      if (!workspaces.has(id)) {
        this.state.entries.delete(id)
      }
    }
    for (const id of workspaces) {
      if (!this.state.entries.has(id)) {
        this.state.entries.set(id, null)
      }
    }
    this.state.inventoryProjection = JSON.stringify([...this.state.entries.keys()])
    this.initialized = true
    return affected
  }

  targetChanged(target: FollowUpTarget): string[] {
    return [...this.batch([target])]
  }
}
