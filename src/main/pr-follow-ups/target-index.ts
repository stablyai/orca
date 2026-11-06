import type { FollowUpTarget } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
import type { createFollowUpProjectionState } from './projection'

export class FollowUpTargetIndex {
  private readonly inventoryKeys = new Map<string, string>()
  readonly byPr = new Map<string, FollowUpTarget[]>()
  readonly byWorkspace = new Map<string, FollowUpTarget>()
  constructor(
    private readonly host: FollowUpEngineDependencies,
    private readonly state: ReturnType<typeof createFollowUpProjectionState>
  ) {}

  refreshInventory(): Set<string> {
    const before = new Map(this.inventoryKeys)
    this.inventoryKeys.clear()
    const affected = new Set<string>()
    const previous = new Map(this.byWorkspace)
    this.byPr.clear()
    this.byWorkspace.clear()
    for (const target of this.host.targets()) {
      this.byWorkspace.set(target.worktreeId, target)
      this.inventoryKeys.set(target.worktreeId, JSON.stringify(target))
      const items = this.byPr.get(target.prKey) ?? []
      items.push(target)
      this.byPr.set(target.prKey, items)
      if (before.get(target.worktreeId) !== JSON.stringify(target)) {
        affected.add(target.prKey)
        const old = before.get(target.worktreeId)
        if (old) {
          affected.add(JSON.parse(old).prKey)
        }
      }
      previous.delete(target.worktreeId)
    }
    for (const old of previous.values()) {
      affected.add(old.prKey)
      this.state.entries.delete(old.worktreeId)
    }
    const ids = new Set(this.host.workspaceIds())
    this.state.inventoryProjection = JSON.stringify([...ids])
    for (const id of this.state.entries.keys()) {
      if (!ids.has(id)) {
        this.state.entries.delete(id)
      }
    }
    for (const id of ids) {
      if (!this.state.entries.has(id)) {
        this.state.entries.set(id, null)
      }
    }
    return affected
  }

  targetRemoved(worktreeId: string, workspaceRemains = false): string[] {
    const target = this.byWorkspace.get(worktreeId)
    this.byWorkspace.delete(worktreeId)
    this.inventoryKeys.delete(worktreeId)
    this.state.entries.delete(worktreeId)
    if (workspaceRemains) {
      this.state.entries.set(worktreeId, null)
    }
    this.state.inventoryProjection = JSON.stringify([...this.state.entries.keys()])
    if (!target) {
      return []
    }
    this.byPr.set(
      target.prKey,
      (this.byPr.get(target.prKey) ?? []).filter((item) => item.worktreeId !== worktreeId)
    )
    return [target.prKey]
  }

  targetChanged(target: FollowUpTarget): string[] {
    const saved = this.inventoryKeys.get(target.worktreeId)
    const old: FollowUpTarget | undefined = saved ? JSON.parse(saved) : undefined
    const fingerprint = JSON.stringify(target)
    if (saved === fingerprint) {
      return []
    }
    if (old) {
      if (old.instanceId !== target.instanceId || old.prKey !== target.prKey) {
        const pr = this.host.store.pr(target.prKey)
        if (pr) {
          pr.needsBaseline = true
          this.host.store.savePr(pr)
        }
      }
      this.byPr.set(
        old.prKey,
        (this.byPr.get(old.prKey) ?? []).filter((item) => item.worktreeId !== old.worktreeId)
      )
    }
    this.byWorkspace.set(target.worktreeId, target)
    this.inventoryKeys.set(target.worktreeId, fingerprint)
    if (!this.state.entries.has(target.worktreeId)) {
      this.state.entries.set(target.worktreeId, null)
      this.state.inventoryProjection = JSON.stringify([...this.state.entries.keys()])
    }
    this.byPr.set(target.prKey, [...(this.byPr.get(target.prKey) ?? []), target])
    return old ? [old.prKey, target.prKey] : [target.prKey]
  }
}
