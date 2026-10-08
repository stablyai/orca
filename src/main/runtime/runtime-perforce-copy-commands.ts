import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { runWithPerforceSettings } from '../../shared/perforce/p4-settings-context'
import type { PerforceSettings } from '../../shared/perforce/perforce-settings'
import {
  requireCopyName,
  requireRemovalOptions
} from '../../shared/perforce/workspace-copy/workspace-copy-arguments'
import type { WorkspaceCopyBackend } from '../../shared/perforce/workspace-copy/workspace-copy-backend'
import type { PerforceCopyOperationName } from '../../shared/perforce/workspace-copy/workspace-copy-operations'
import { copyRemovalRefusal } from '../../shared/perforce/workspace-copy/workspace-copy-remove'
import type {
  WorkspaceCopyListResult,
  WorkspaceCopyRemovalResult
} from '../../shared/perforce/workspace-copy/workspace-copy-types'
import { isFolderRepo, isPerforceRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { resolveWorkspaceCopyBackend } from '../perforce/perforce-copy-backend'
import {
  createPerforceCopyForWorkspace,
  type PerforceCopyCreation
} from '../perforce/perforce-copy-creation'
import {
  copyWorktreeIdForName,
  syncCopyWorktrees,
  type CopyWorktreeStore
} from '../perforce/perforce-copy-worktrees'
import type { RuntimeStore } from './runtime-store-contract'
import {
  perforceBackendForHost,
  perforceConnectionIdForHost,
  perforceSettingsForRequest
} from './runtime-perforce-commands'

const GB = 1024 ** 3

function copyBackendFor(repo: Repo): WorkspaceCopyBackend {
  return resolveWorkspaceCopyBackend(perforceConnectionIdForHost(getRepoExecutionHostId(repo)))
}

/**
 * The copy behind a new workspace of Perforce project `repo`, for the runtime's Create workspace;
 * `hostSettings` are this server's, under the client's request settings.
 */
export async function createRuntimePerforceCopy(
  repo: Repo,
  request: { workspaceName: string; stream?: unknown; settings?: unknown },
  hostSettings: { perforce?: GlobalSettings['perforce'] }
): Promise<PerforceCopyCreation> {
  const settings = perforceSettingsForRequest(request.settings, hostSettings.perforce)
  const creation = await runWithPerforceSettings(settings, () =>
    createPerforceCopyForWorkspace({
      backend: copyBackendFor(repo),
      repo,
      sourceDir: repo.path,
      workspaceName: request.workspaceName,
      stream: request.stream,
      settings
    })
  )
  return creation
}

function readableProjectError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'repo_not_found') {
    return 'This project is no longer in Orca on this host. Refresh projects and try again.'
  }
  if (code === 'selector_ambiguous') {
    return 'More than one project on this host has this id. Refresh projects and try again.'
  }
  return code
}

export type RuntimePerforceCopyCommandHost = {
  resolveRepo(selector: string): Promise<Repo>
  getStore(): CopyWorktreeStore & Pick<RuntimeStore, 'updateRepo'>
  getRuntimeSettings(): { perforce?: GlobalSettings['perforce'] }
  acquireFileWatcherRemoval(
    path: string,
    connectionId?: string
  ): Promise<{ finish(completed: boolean): Promise<void> }>
  /** Stops the workspace's terminals and agent sessions; throws when it cannot prove they stopped. */
  stopWorkspaceTerminals(worktreeId: string, connectionId: string | null): Promise<void>
  forgetWorktree(worktreeId: string, repoId: string, hostId: ExecutionHostId): void
  worktreesChanged(repoId: string): void
  reposChanged(): void
}

/**
 * Perforce copies of the folder projects this host owns. Desktop IPC delegates here too, so a copy
 * is listed, adopted and removed the same way on a desktop and on an Orca server.
 */
export class RuntimePerforceCopyCommands {
  constructor(private readonly host: RuntimePerforceCopyCommandHost) {}

  async runPerforceCopyOperation(
    repoSelector: string,
    operation: PerforceCopyOperationName,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    const repo = await this.host.resolveRepo(repoSelector).catch((error: unknown) => {
      throw new Error(readableProjectError(error))
    })
    return this.runPerforceCopyOperationOnRepo(repo, operation, params)
  }

  /** For a caller that already resolved the project on its host (desktop IPC). */
  runPerforceCopyOperationOnRepo(
    repo: Repo,
    operation: PerforceCopyOperationName,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    if (!isFolderRepo(repo)) {
      throw new Error('Perforce copies belong to a folder project; this project is not one.')
    }
    const settings = perforceSettingsForRequest(
      params.settings,
      this.host.getRuntimeSettings().perforce
    )
    return runWithPerforceSettings(settings, () => this.run(repo, operation, params, settings))
  }

  private run(
    repo: Repo,
    operation: PerforceCopyOperationName,
    params: Readonly<Record<string, unknown>>,
    settings: PerforceSettings
  ): Promise<unknown> {
    const hostId = getRepoExecutionHostId(repo)
    const backend = copyBackendFor(repo)
    switch (operation) {
      case 'copyReadiness':
        return backend.readiness(repo.path, settings.copyMinFreeSpaceGb * GB)
      case 'listCopyStreams':
        return backend.streams(repo.path)
      case 'detectProject':
        return this.detectProject(repo, hostId)
      case 'syncCopies':
        return this.syncCopies(repo, hostId, backend)
      case 'previewCopyRemoval':
        return backend.previewRemoval(repo.path, requireCopyName(params.name))
      case 'removeCopy':
        return this.removeCopy(repo, hostId, backend, params)
    }
  }

  // Never unmarks: a server that does not answer is no evidence the folder stopped being a workspace.
  private async detectProject(repo: Repo, hostId: ExecutionHostId): Promise<boolean> {
    if (isPerforceRepo(repo)) {
      return true
    }
    const detected = await perforceBackendForHost(hostId).detect(repo.path)
    if (!detected.isWorkspace) {
      return false
    }
    this.host.getStore().updateRepo(repo.id, { vcs: 'perforce' }, hostId)
    this.host.reposChanged()
    return true
  }

  private async syncCopies(
    repo: Repo,
    hostId: ExecutionHostId,
    backend: WorkspaceCopyBackend
  ): Promise<WorkspaceCopyListResult> {
    const listing = await backend.list(repo.path)
    const forget = (worktreeId: string): void =>
      this.host.forgetWorktree(worktreeId, repo.id, hostId)
    if (syncCopyWorktrees(this.host.getStore(), repo, listing, forget)) {
      // Why: an adopted copy's folder is an authorized root, so file operations must see it at once.
      invalidateAuthorizedRootsCache()
      this.host.worktreesChanged(repo.id)
    }
    return listing
  }

  private async removeCopy(
    repo: Repo,
    hostId: ExecutionHostId,
    backend: WorkspaceCopyBackend,
    params: Readonly<Record<string, unknown>>
  ): Promise<WorkspaceCopyRemovalResult> {
    const name = requireCopyName(params.name)
    const options = requireRemovalOptions(params)
    // Why first: a refusal must not have already closed the copy's terminals.
    const refusal = copyRemovalRefusal(await backend.previewRemoval(repo.path, name), options)
    if (refusal) {
      throw new Error(refusal)
    }
    const found = copyWorktreeIdForName(this.host.getStore(), repo, name)
    const connectionId = perforceConnectionIdForHost(hostId)
    // Why: watchers and terminals hold handles inside the copy, and Windows will not move a folder in use.
    const gate = found
      ? await this.host.acquireFileWatcherRemoval(found.path, connectionId ?? undefined)
      : null
    let completed = false
    let result: WorkspaceCopyRemovalResult
    try {
      if (found) {
        await this.host.stopWorkspaceTerminals(found.worktreeId, connectionId)
      }
      result = await backend.remove(repo.path, name, options)
      completed = true
    } finally {
      await gate?.finish(completed)
    }
    if (found) {
      this.host.forgetWorktree(found.worktreeId, repo.id, hostId)
    }
    this.host.worktreesChanged(repo.id)
    return result
  }
}
