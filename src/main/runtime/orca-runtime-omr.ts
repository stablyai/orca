import type { ExecutionHostId } from '../../shared/execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { MaestroBrowserSurfaceReceipt } from '../../shared/maestro-browser-surface'
import type { RuntimeRunSettlementResult } from '../../shared/runtime-worktree-contracts'
import { collectRunOwnedChildWorktrees } from '../../shared/runtime-worktree-contracts'
import { isFolderRepo } from '../../shared/repo-kind'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import { listWorktreesStrict } from '../git/worktree'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../worktree-removal-repo-owner'
import { createHeadlessMaestroAnnotationSnapshot } from './maestro-workspace-headless-annotation'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import {
  createMaestroBrowserSurfaceReconciliationHost,
  reconcileMaestroBrowserSurfaces
} from './orchestration/maestro-browser-surface-reconciliation'
import { parseWorkerTerminalHostScope } from './orchestration/worker-terminal-process-liveness'
import { settleRunOwnedChildWorktrees } from './orchestration/run-owned-child-worktree-settlement'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { isRuntimeWorktreePathMissing } from './runtime-worktree-filesystem'
import { parseExactWorktreeIdSelector } from './runtime-worktree-selection'

export class OrcaRuntimeWithOmr extends OrcaRuntimeWithResolveWaiter {
  private browserSurfaceReconciliation: Promise<void> | null = null

  async openMaestroCanvas(target: {
    executionHostId: string
    workspaceKey: string
  }): Promise<boolean> {
    return (await this.notifier?.openMaestroCanvas?.(target)) ?? false
  }

  async commandMaestroWorkspaceTab(
    command:
      | {
          kind: 'open-annotation'
          worktreeId: string
          filePath: string
          relativePath: string
          title?: string
        }
      | { kind: 'rename'; worktreeId: string; tabId: string; title: string }
      | { kind: 'read-content'; worktreeId: string; tabId: string }
      | { kind: 'focus'; worktreeId: string; tabId: string }
  ): Promise<{ tabId: string; content?: string; modelRevision?: string }> {
    if (this.notifier?.commandMaestroWorkspaceTab) {
      return await this.notifier.commandMaestroWorkspaceTab(command)
    }
    if (command.kind === 'focus') {
      const activated = await this.activateMobileSessionTab(
        `id:${command.worktreeId}`,
        command.tabId
      )
      if (activated.activeTabId !== command.tabId) {
        throw new Error('focus_tab_identity_mismatch')
      }
      return { tabId: command.tabId }
    }
    if (command.kind !== 'open-annotation') {
      throw new Error('renderer_unavailable')
    }
    const result = createHeadlessMaestroAnnotationSnapshot({
      existing: this.mobileSessionTabsByWorktree.get(command.worktreeId),
      worktreeId: command.worktreeId,
      filePath: command.filePath,
      relativePath: command.relativePath,
      title: command.title ?? 'Workspace note',
      fallbackGroupId: getHeadlessMobileSessionGroupId(command.worktreeId)
    })
    this.mobileSessionTabsByWorktree.set(command.worktreeId, result.snapshot)
    this.emitMobileSessionTabsSnapshot(result.snapshot)
    return { tabId: result.tabId }
  }

  protected scheduleMaestroBrowserSurfaceReconciliation(): void {
    if (!this._orchestrationDb || this.browserSurfaceReconciliation) {
      return
    }
    this.browserSurfaceReconciliation = reconcileMaestroBrowserSurfaces(
      this._orchestrationDb,
      createMaestroBrowserSurfaceReconciliationHost(this as RuntimeCommandSurfaceHost<this>)
    )
      .then(() => undefined)
      .catch((error) => {
        console.warn('[orchestration] browser surface reconciliation failed', error)
      })
      .finally(() => {
        this.browserSurfaceReconciliation = null
      })
  }

  private workerResourceBelongsToRunHost(
    hostScope: ReturnType<typeof parseWorkerTerminalHostScope>,
    executionHostId: ExecutionHostId
  ): boolean {
    const executionHost = parseExecutionHostId(executionHostId)
    if (!hostScope || !executionHost) {
      throw new Error('Worker terminal host authority is unverifiable.')
    }
    return executionHost.kind === 'ssh'
      ? hostScope.kind === 'ssh' && hostScope.targetId === executionHost.targetId
      : hostScope.kind === 'local'
  }

  private retainRunWorktreeForDurableResource(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): string | undefined {
    const db = this.getOrchestrationDb()
    for (const worker of db.listWorkerTerminalResources()) {
      const resource = worker.resource
      if (!resource || resource.worktree_id !== worktreeId) {
        continue
      }
      if (
        !this.workerResourceBelongsToRunHost(
          parseWorkerTerminalHostScope(resource.host_scope),
          executionHostId
        )
      ) {
        continue
      }
      if (
        resource.ownership_state === 'transferred' ||
        resource.ownership_state === 'user_owned' ||
        resource.release_state === 'retained' ||
        resource.release_state === 'retained_for_review'
      ) {
        return `Worker terminal resource ${resource.id} is ${resource.ownership_state}/${resource.release_state}.`
      }
    }
    const surfaces = db.db
      .prepare(
        `SELECT receipt_json FROM maestro_browser_surfaces
         WHERE execution_host_id = ? AND workspace_key = ?`
      )
      .all(executionHostId, worktreeWorkspaceKey(worktreeId)) as { receipt_json: string }[]
    for (const row of surfaces) {
      try {
        const receipt = JSON.parse(row.receipt_json) as Pick<
          MaestroBrowserSurfaceReceipt,
          'ownership' | 'retention'
        >
        if (receipt.ownership === 'user' || receipt.retention === 'retain') {
          return `Browser surface is ${receipt.ownership}/${receipt.retention}.`
        }
      } catch {
        return 'Browser surface ownership is unverifiable.'
      }
    }
    return undefined
  }

  private async assertRunWorktreeAbsent(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): Promise<void> {
    const store = this.requireStore()
    const target = parseExactWorktreeIdSelector(`id:${worktreeId}`)
    if (!target) {
      throw new Error(`Worktree identity is unverifiable: ${worktreeId}`)
    }
    const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, executionHostId)
    if (owner.kind !== 'resolved') {
      throw new Error(`Worktree project authority is unverifiable: ${worktreeId}`)
    }
    const repo = owner.repo
    if (isFolderRepo(repo)) {
      throw new Error('Folder workspaces are not worktree deletion targets.')
    }
    const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
    const localOptions = repo.connectionId ? {} : getLocalProjectWorktreeGitOptions(store, repo)
    const worktrees = provider
      ? await provider.listWorktrees(repo.path)
      : Object.keys(localOptions).length > 0
        ? await listWorktreesStrict(repo.path, localOptions)
        : await listWorktreesStrict(repo.path)
    if (worktrees.some((worktree) => areWorktreePathsEqual(worktree.path, target.path))) {
      throw new Error(`Worktree remains registered after removal: ${target.path}`)
    }
    if (!(await isRuntimeWorktreePathMissing(executionHostId, target.path, localOptions))) {
      throw new Error(`Worktree absence is unverifiable after removal: ${target.path}`)
    }
    if (resolveWorktreeRemovalMetadata(store, target.repoId, target.id, executionHostId)) {
      throw new Error(`Worktree remains registered in Orca after removal: ${worktreeId}`)
    }
  }

  async settleOrchestrationRun(runId: string): Promise<RuntimeRunSettlementResult> {
    const db = this.getOrchestrationDb()
    if (!db.getRun(runId)) {
      throw new Error(`Run ${runId} was not found.`)
    }
    const rows = db.db
      .prepare(
        `SELECT wd.effects FROM dispatch_contexts dc
         JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE dc.run_id = ? ORDER BY dc.id`
      )
      .all(runId) as { effects: string }[]
    const owned = collectRunOwnedChildWorktrees(rows)
    let processEvidence
    let processEvidenceError: string | undefined
    try {
      const evidence = await this.getWorktreePs(Number.MAX_SAFE_INTEGER)
      processEvidence = {
        summaries: evidence.worktrees,
        queriedHostIds: new Set(evidence.queriedHostIds)
      }
    } catch (error) {
      processEvidenceError = error instanceof Error ? error.message : String(error)
    }
    return await settleRunOwnedChildWorktrees({
      runId,
      worktrees: owned.worktrees,
      unreadableEffectRows: owned.unreadableEffectRows,
      processEvidence,
      processEvidenceError,
      authority: {
        assertAbsent: (target) =>
          this.assertRunWorktreeAbsent(target.worktreeId, target.executionHostId),
        retentionCause: (target) =>
          this.retainRunWorktreeForDurableResource(target.worktreeId, target.executionHostId),
        remove: async (target) => {
          const repoId = splitWorktreeId(target.worktreeId)?.repoId ?? ''
          const meta = resolveWorktreeRemovalMetadata(
            this.requireStore(),
            repoId,
            target.worktreeId,
            target.executionHostId
          )
          if (meta?.instanceId !== target.worktreeInstanceId) {
            throw new Error('Checkout instance identity changed before Run settlement.')
          }
          if (meta) {
            if (this.store?.setWorktreeMetaForHost) {
              this.store.setWorktreeMetaForHost(target.worktreeId, target.executionHostId, {
                preserveBranchOnDelete: true
              })
            } else if (meta.hostId === target.executionHostId) {
              this.store?.setWorktreeMeta(target.worktreeId, { preserveBranchOnDelete: true })
            } else {
              throw new Error('Host-qualified worktree metadata updates are unavailable.')
            }
          }
          await this.removeManagedWorktree(
            `id:${target.worktreeId}`,
            true,
            false,
            false,
            target.executionHostId,
            target.worktreeInstanceId
          )
          return { wasRegistered: Boolean(meta) }
        }
      }
    })
  }
}
