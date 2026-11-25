import {
  quoteStartupArg,
  resolveStartupShell
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { resolveFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'
import { readWorkerTerminalHostScope } from '../../../../shared/orchestration/workers/worker-terminal-host-scope'
import { adoptExistingWorktree } from './adopt-existing-worktree'
import { workspacePrCopy } from '../../../../shared/orchestration/workspace-pr-copy'
import { LineageUncertaintyKeyIndex } from '../../../../shared/worktree/lineage/lineage-uncertainty'
import {
  checkWorkspacePullRequests,
  type WorkspaceCheck
} from '../../../../shared/orchestration/workspace-pr-check'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../../terminal/launch/terminal-workspace-scope'
import {
  getRepoExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/orchestration/workers/nested-worker-depth'
import type { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type {
  CrossStoreWorkspaceLineage,
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { Repo } from '../../../../shared/repository/repo-types'
export abstract class RuntimeWorktreeLineageOperations extends OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree {
  private readonly lineageUncertaintyKeys = new LineageUncertaintyKeyIndex()
  /** `childRepo` scopes the parent to the new worktree's execution host (#12757). */
  resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution> {
    return this.worktreeLineage.resolveCreate(
      input,
      childRepo ? getRepoExecutionHostId(childRepo) : undefined
    )
  }

  protected getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this._orchestrationDb
  }

  getNestedWorkerMaxDepth(): number {
    return resolveNestedWorkerMaxDepth({
      nestedWorkerMaxDepth: this.store?.getSettings?.()?.nestedWorkerMaxDepth
    })
  }

  async adoptManagedExternalWorktree(path: string, parentSelector: string) {
    if (!this.store) {
      throw new Error(workspacePrCopy.parent_unavailable())
    }
    const beforeResolution = {
      legacy: { ...this.store.getAllWorktreeLineage?.() },
      workspace: { ...this.store.getAllWorkspaceLineage?.() },
      cross: {
        ...(this.store.getRawCrossStoreWorkspaceLineage?.() ??
          this.store.getAllCrossStoreWorkspaceLineage?.())
      }
    }
    const child = await this.showManagedWorktree(`path:${path}`).catch((cause: unknown) => {
      throw Object.assign(new Error(workspacePrCopy.not_a_project_worktree(path)), {
        code: 'not_a_project_worktree',
        cause
      })
    })
    const parent = await this.worktreeLineage.resolveParent(parentSelector, { matchFolders: true })
    return adoptExistingWorktree(
      this.store,
      child,
      parent,
      () => {
        if (parent.type === 'worktree') {
          this.worktreeLineage.validateParent(child, parent.worktree)
        }
      },
      beforeResolution
    )
  }

  getOrchestrationWorkspaceSelectorArgument(handle: string, id: string): string {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    const shell =
      pty?.connectionId || pty?.isWsl
        ? 'posix'
        : resolveStartupShell(
            process.platform,
            resolveLocalWindowsAgentStartupShell({
              platform: process.platform,
              isRemote: false,
              terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell
            })
          )
    return quoteStartupArg(`id:${id}`, shell)
  }
  checkReportedWorkspacePrs(dispatchId: string, subject: string, body: string): WorkspaceCheck {
    const skipped: WorkspaceCheck = { version: 1, state: 'skipped', outside: [] }
    try {
      const db = this.getOrchestrationDbIfAvailable()
      const store = this.store
      if (!db || !store || db.getFederatedDispatch(dispatchId)) {
        return skipped
      }
      if (
        !store.getAllWorktreeLineage ||
        !store.getAllWorkspaceLineage ||
        !(store.getRawCrossStoreWorkspaceLineage || store.getAllCrossStoreWorkspaceLineage) ||
        !store.getWorkspaceLineageUncertainty
      ) {
        return skipped
      }
      const dispatch = db.getDispatchContextById(dispatchId)
      const primary = db.getWorkerDispatch(dispatchId)?.worktree_id
      if (!dispatch || !primary) {
        return skipped
      }
      const repos = store.getRepos()
      const folders = store.getFolderWorkspaces?.() ?? []
      const groups = store.getProjectGroups?.() ?? []
      if (repos.length + folders.length + groups.length > 200) {
        return { version: 1, state: 'partial', outside: [] }
      }
      const groupsById = new Map<string, (typeof groups)[number] | undefined>()
      for (const group of groups) {
        groupsById.set(group.id, groupsById.has(group.id) ? undefined : group)
      }
      const folderHosts = new Map<string, ReturnType<typeof resolveFolderWorkspaceHostId>>()
      for (const folder of folders) {
        const group = groupsById.get(folder.projectGroupId)
        const host = resolveFolderWorkspaceHostId(folder, group ? [group] : [])
        folderHosts.set(folder.id, folderHosts.has(folder.id) ? undefined : host)
      }
      const hostOf = (workspace: string) => {
        if (workspace.startsWith('folder:')) {
          const folder = folders.filter((row) => row.id === workspace.slice(7))
          return folder.length === 1 ? folderHosts.get(folder[0]!.id) : undefined
        }
        const rows = repos.filter((row) => row.id === getRepoIdFromWorktreeId(workspace))
        return rows.length === 1 ? getRepoExecutionHostId(rows[0]!) : undefined
      }
      const host = hostOf(primary)
      if (!host) {
        return { version: 1, state: 'partial', outside: [] }
      }
      const primaries: string[] = [],
        pending = [dispatchId],
        seen = new Set<string>()
      let incomplete = false
      for (let i = 0; i < pending.length; i++) {
        const id = pending[i]!
        if (seen.has(id) || seen.size === 128) {
          incomplete = true
          break
        }
        seen.add(id)
        const row = db.getDispatchContextById(id)
        const workspace = db.getWorkerDispatch(id)?.worktree_id
        if (!row || !workspace) {
          incomplete = true
          continue
        }
        const scope = readWorkerTerminalHostScope(row.host_scope)
        if (
          hostOf(workspace) !== host ||
          scope.kind === 'unreadable' ||
          (scope.kind === 'remote' &&
            (!scope.targetId || toSshExecutionHostId(scope.targetId) !== host)) ||
          (scope.kind === 'local' && host !== 'local')
        ) {
          incomplete = true
        } else {
          primaries.push(workspace)
        }
        if (row.follow_up_of_dispatch_id) {
          pending.push(row.follow_up_of_dispatch_id)
        }
        if (row.retry_of_dispatch_id) {
          pending.push(row.retry_of_dispatch_id)
        }
      }
      return checkWorkspacePullRequests(
        {
          repos,
          metadata: (id, expectedHost) => {
            const meta = store.getWorktreeMetaForHost?.(id, host, { migrate: false })
            return meta?.hostId === expectedHost ? meta : undefined
          },
          lineage: store.getAllWorktreeLineage?.() ?? {},
          workspaceLineage: store.getAllWorkspaceLineage?.() ?? {},
          crossStoreLineage:
            store.getRawCrossStoreWorkspaceLineage?.() ??
            store.getAllCrossStoreWorkspaceLineage?.() ??
            {},
          childIndex: store.getLineageChildIndex
            ? (limit) => store.getLineageChildIndex!(limit)
            : undefined,
          uncertainty: store.getWorkspaceLineageUncertainty?.() ?? {},
          decodeUncertaintyKey: (key) => this.lineageUncertaintyKeys.decode(key),
          folders,
          folderHost: (folder) => folderHosts.get(folder.id),
          primaries,
          incomplete
        },
        { subject, body, spec: db.getTask(dispatch.task_id)?.spec ?? '', host }
      )
    } catch {
      return skipped
    }
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }

  listCrossStoreLineage(): Record<WorkspaceKey, CrossStoreWorkspaceLineage> {
    return this.store?.getAllCrossStoreWorkspaceLineage?.() ?? {}
  }

  resolveCallerParentForAnotherStore(
    ...args: Parameters<RuntimeWorktreeLineageController['resolveCallerParentForAnotherStore']>
  ): ReturnType<RuntimeWorktreeLineageController['resolveCallerParentForAnotherStore']> {
    return this.worktreeLineage.resolveCallerParentForAnotherStore(...args)
  }

  /** This store's installationId; cross-store records name their parent's store by it. */
  readStoreInstallationId(): Promise<string | undefined> {
    return this.worktreeLineage.readStoreInstallationId()
  }
}
