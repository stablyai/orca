import type {
  FollowUpHostInputs,
  FollowUpObservationSource,
  FollowUpWorkspace,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import { resolvePrFollowUps, type PrFollowUpsSettings } from '../../shared/pr-follow-ups/settings'
import type { FollowUpEngine } from './engine'
import type { FollowUpStore } from './store'

export class FollowUpInventory {
  private workspaces: readonly FollowUpWorkspace[]
  readonly byInstance = new Map<string, FollowUpWorkspace>()
  private readonly byRepo = new Map<string, Set<string>>()
  private readonly byPr = new Map<string, Set<string>>()
  private readonly targets = new Map<string, FollowUpTarget>()
  private targetSnapshot: readonly FollowUpTarget[]
  private readonly launchKeys = new Map<string, string>()
  private readonly registrations = new Map<
    string,
    { fingerprint: string; handle: { unregister(): void } }
  >()

  constructor(
    private readonly inputs: FollowUpHostInputs,
    private readonly source: FollowUpObservationSource,
    private readonly records: FollowUpStore,
    private readonly engine: FollowUpEngine,
    private readonly settings: () => PrFollowUpsSettings | undefined
  ) {
    this.workspaces = inputs.workspaces()
    this.targetSnapshot = inputs.targets()
    for (const target of this.targetSnapshot) {
      this.targets.set(target.worktreeId, target)
      this.launchKeys.set(target.worktreeId, this.launchKey(target))
    }
    for (const workspace of this.workspaces) {
      this.index(workspace)
    }
  }

  private launchKey(target: FollowUpTarget): string {
    try {
      return JSON.stringify(this.inputs.launchInputs(target))
    } catch {
      // Per-action preparation records failures; inventory admission must not abort other PRs.
      return 'unavailable'
    }
  }

  private index(workspace: FollowUpWorkspace): void {
    this.byInstance.set(workspace.instanceId, workspace)
    const key = this.targets.get(workspace.worktreeId)?.prKey ?? ''
    for (const [map, id] of [
      [this.byPr, key],
      [this.byRepo, workspace.repoId]
    ] as const) {
      const instances = map.get(id) ?? new Set<string>()
      instances.add(workspace.instanceId)
      map.set(id, instances)
    }
  }

  private unindex(workspace: FollowUpWorkspace): void {
    this.byInstance.delete(workspace.instanceId)
    const key = this.targets.get(workspace.worktreeId)?.prKey ?? ''
    for (const [map, id] of [
      [this.byPr, key],
      [this.byRepo, workspace.repoId]
    ] as const) {
      const instances = map.get(id)
      instances?.delete(workspace.instanceId)
      if (!instances?.size) {
        map.delete(id)
      }
    }
  }

  private release(id: string): void {
    this.registrations.get(id)?.handle.unregister()
    this.registrations.delete(id)
  }

  refresh(repoId?: string): Set<string> {
    const affected = new Set<string>()
    if (repoId && !this.byRepo.has(repoId)) {
      return affected
    }
    const next = this.inputs.workspaces()
    const targets = this.inputs.targets()
    if (next === this.workspaces && targets === this.targetSnapshot) {
      return affected
    }
    const nextById = new Map(next.map((item) => [item.instanceId, item]))
    const nextWorktrees = new Set(next.map((item) => item.worktreeId))
    const nextTargets = new Map(targets.map((item) => [item.worktreeId, item]))
    const changed = new Set<string>()
    for (const old of this.byInstance.values()) {
      if (
        nextById.get(old.instanceId) !== old ||
        nextTargets.get(old.worktreeId) !== this.targets.get(old.worktreeId)
      ) {
        changed.add(old.instanceId)
      }
    }
    for (const workspace of next) {
      if (!this.byInstance.has(workspace.instanceId)) {
        changed.add(workspace.instanceId)
      }
    }
    const updates: FollowUpTarget[] = []
    const removals: { worktreeId: string; workspaceRemains?: boolean }[] = []
    for (const id of changed) {
      const old = this.byInstance.get(id)
      const workspace = nextById.get(id)
      if (old) {
        affected.add(this.targets.get(old.worktreeId)?.prKey ?? '')
        this.unindex(old)
        this.targets.delete(old.worktreeId)
        this.launchKeys.delete(old.worktreeId)
        if (!workspace) {
          this.release(id)
          if (!nextWorktrees.has(old.worktreeId)) {
            removals.push({ worktreeId: old.worktreeId })
          }
        }
      }
      if (workspace) {
        const target = nextTargets.get(workspace.worktreeId)
        if (target) {
          this.targets.set(target.worktreeId, target)
          this.launchKeys.set(target.worktreeId, this.launchKey(target))
          updates.push(target)
          affected.add(target.prKey)
        } else {
          removals.push({ worktreeId: workspace.worktreeId, workspaceRemains: true })
          affected.add('')
        }
        this.index(workspace)
      }
    }
    for (const key of this.engine.targetsChanged(updates, removals)) {
      affected.add(key)
    }
    this.forgetUnwatched(affected)
    this.workspaces = next
    this.targetSnapshot = targets
    return affected
  }

  effectiveInputsChanged(): Set<string> {
    const affected = new Set<string>()
    for (const target of this.targets.values()) {
      const key = this.launchKey(target)
      if (this.launchKeys.get(target.worktreeId) !== key) {
        this.launchKeys.set(target.worktreeId, key)
        affected.add(target.prKey)
      }
    }
    return affected
  }

  private forgetUnwatched(keys: Iterable<string>): void {
    for (const key of keys) {
      if (![...(this.byPr.get(key) ?? [])].some((id) => this.registrations.has(id))) {
        if (this.engine.forgetObservation(key)) {
          const pr = this.records.pr(key)
          if (pr && !pr.needsBaseline) {
            pr.needsBaseline = true
            this.records.savePr(pr)
          }
        }
      }
    }
  }

  sync(keys: readonly string[] = [...this.byPr.keys()]): void {
    for (const prKey of keys) {
      const pr = prKey ? this.records.pr(prKey) : undefined
      const paused = pr && (pr.stoppedAt !== null || pr.consecutiveReadFailures >= 8)
      for (const id of this.byPr.get(prKey) ?? []) {
        const workspace = this.byInstance.get(id)!
        const settings = resolvePrFollowUps(this.settings(), workspace.settings)
        const { repoId, connectionId, branch, prNumber } = workspace
        const key =
          !workspace.archived &&
          !paused &&
          branch &&
          settings.enabled &&
          settings.ciFailed !== 'off'
            ? JSON.stringify([repoId, connectionId, branch, prNumber])
            : undefined
        if (this.registrations.get(id)?.fingerprint === key) {
          continue
        }
        this.release(id)
        if (key) {
          this.registrations.set(id, {
            fingerprint: key,
            handle: this.source.registerPRWatch({
              repoId,
              connectionId,
              branch,
              prNumber,
              reason: 'pr-follow-ups'
            })
          })
        }
      }
    }
    this.forgetUnwatched(keys)
  }

  dispose(): void {
    for (const id of this.registrations.keys()) {
      this.release(id)
    }
  }
}
