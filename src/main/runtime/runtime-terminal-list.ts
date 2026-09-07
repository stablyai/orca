import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../shared/runtime-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { buildRuntimeTerminalVisualLayouts } from './runtime-terminal-visual-layout'
import {
  includeTargetResolvedWorktree,
  type ResolvedWorktree
} from './runtime-worktree-path-identity'

type RuntimeTerminalListDependencies = {
  getGraphEpoch(): number | null
  assertGraphEpoch(epoch: number): void
  getExplicitWorktreeId(selector: string): string | null
  getResolvedCache(): (ResolvedWorktreeSnapshot & { expiresAt: number }) | null
  buildWorktreeFromId(worktreeId: string): ResolvedWorktree | null
  resolveWorktree(selector: string): Promise<ResolvedWorktree>
  listKnownWorktrees(worktreeId: string, target: ResolvedWorktree | null): ResolvedWorktree[]
  getWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  refreshPtys(
    worktrees: ResolvedWorktree[],
    targetWorktreeId: string | null
  ): Promise<PtyControllerInventory | null>
  getPtys(): Iterable<RuntimePtyWorktreeRecord>
  getLeaves(): Iterable<RuntimeLeafRecord>
  buildLeafSummary(
    leaf: RuntimeLeafRecord,
    worktrees: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null
  ): RuntimeTerminalSummary
  buildPtySummary(
    pty: RuntimePtyWorktreeRecord,
    worktrees: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary
  getSnapshots(): ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  getTabTitle(tabId: string): string | null
  getTopologyRevision(worktreeId: string): number
  buildHostScope(
    targetWorktreeId: string | null,
    terminals: readonly RuntimeTerminalSummary[],
    worktrees: Iterable<ResolvedWorktree>,
    queriedHostIds: ReadonlySet<ExecutionHostId>
  ): { hostIds: ExecutionHostId[]; omittedHostIds: ExecutionHostId[] }
}

export class RuntimeTerminalList {
  constructor(private readonly deps: RuntimeTerminalListDependencies) {}

  async list(
    worktreeSelector: string | undefined,
    limit: number,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    }
  ): Promise<RuntimeTerminalListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const graphEpoch = this.deps.getGraphEpoch()
    const explicitId = worktreeSelector ? this.deps.getExplicitWorktreeId(worktreeSelector) : null
    const initialCache = this.deps.getResolvedCache()
    const cachedWorktrees =
      initialCache?.expiresAt && initialCache.expiresAt > Date.now() ? initialCache.worktrees : null
    const cachedTarget =
      explicitId && cachedWorktrees
        ? (cachedWorktrees.find((worktree) => worktree.id === explicitId) ?? null)
        : null
    const parsedTarget =
      explicitId && !cachedTarget ? this.deps.buildWorktreeFromId(explicitId) : null
    const target =
      worktreeSelector && !explicitId
        ? await this.deps.resolveWorktree(worktreeSelector)
        : (cachedTarget ?? parsedTarget)
    const targetId = explicitId ?? target?.id ?? null
    const classificationCache = this.deps.getResolvedCache()
    const classificationWorktrees =
      targetId && classificationCache && classificationCache.expiresAt > Date.now()
        ? includeTargetResolvedWorktree(classificationCache.worktrees, target)
        : targetId && explicitId
          ? this.deps.listKnownWorktrees(targetId, target)
          : null
    const worktreesById =
      targetId && target
        ? new Map([[target.id, target]])
        : targetId
          ? new Map<string, ResolvedWorktree>()
          : await this.deps.getWorktreeMap()
    if (graphEpoch !== null) {
      this.deps.assertGraphEpoch(graphEpoch)
    }
    const resolvedWorktrees =
      targetId && classificationWorktrees
        ? classificationWorktrees
        : targetId && target
          ? [target]
          : targetId
            ? []
            : [...worktreesById.values()]
    const inventory = await this.deps.refreshPtys(resolvedWorktrees, targetId)
    const refreshedPtyIds = inventory ? new Set(inventory.livePtyIds) : null
    if (opts.requireFreshPtyLiveness && !refreshedPtyIds) {
      throw new Error('terminal_liveness_unavailable')
    }
    const provenLivePtyIds = inventory?.allLivePtyIds ?? null
    const ptys = [...this.deps.getPtys()]
    const liveWorktreeIds = new Set(
      ptys.filter((pty) => pty.connected).map((pty) => pty.worktreeId)
    )
    const terminals: RuntimeTerminalSummary[] = []
    const leafPtyIds = new Set<string>()
    if (graphEpoch !== null) {
      for (const leaf of this.deps.getLeaves()) {
        if (targetId && leaf.worktreeId !== targetId) {
          continue
        }
        if (opts.requireFreshPtyLiveness && (!leaf.ptyId || !refreshedPtyIds?.has(leaf.ptyId))) {
          continue
        }
        if (!leaf.ptyId && liveWorktreeIds.has(leaf.worktreeId)) {
          continue
        }
        if (leaf.ptyId) {
          leafPtyIds.add(leaf.ptyId)
        }
        terminals.push(this.deps.buildLeafSummary(leaf, worktreesById, provenLivePtyIds))
      }
    }
    for (const pty of ptys) {
      if (!pty.connected || leafPtyIds.has(pty.ptyId)) {
        continue
      }
      if (opts.requireFreshPtyLiveness && !refreshedPtyIds?.has(pty.ptyId)) {
        continue
      }
      if (targetId && pty.worktreeId !== targetId) {
        continue
      }
      terminals.push(this.deps.buildPtySummary(pty, worktreesById))
    }
    const requestedHandles = opts.handles ? new Set(opts.handles) : null
    const matching = requestedHandles
      ? terminals.filter((terminal) => requestedHandles.has(terminal.handle))
      : terminals
    const listed = matching.slice(0, limit)
    const snapshots = this.deps.getSnapshots()
    const visualLayouts =
      opts.includeVisualLayouts === false
        ? []
        : buildRuntimeTerminalVisualLayouts({
            terminals: listed,
            worktreesById,
            snapshots: targetId
              ? [snapshots.get(targetId)].filter(
                  (snapshot): snapshot is RuntimeMobileSessionTabsSnapshot => snapshot !== undefined
                )
              : snapshots.values(),
            getTabTitle: (tabId) => this.deps.getTabTitle(tabId)
          })
    return {
      terminals: listed,
      hostScope: this.deps.buildHostScope(
        targetId,
        matching,
        worktreesById.values(),
        (inventory?.queriedHostIds ?? new Set()) as ReadonlySet<ExecutionHostId>
      ),
      ...(visualLayouts.length > 0 ? { visualLayouts } : {}),
      topologyRevisions: Object.fromEntries(
        [...new Set(matching.map((terminal) => terminal.worktreeId))].map((worktreeId) => [
          worktreeId,
          this.deps.getTopologyRevision(worktreeId)
        ])
      ),
      totalCount: matching.length,
      truncated: matching.length > limit
    }
  }
}
