import { type BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import type {
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult
} from '../../../shared/project-types'
import { getProjectHostSetupForRepo } from '../../../shared/project-host-setup-lookup'
import { repoIdForHostLocalProjectId } from '../../../shared/project-host-setup-projection'
import {
  linkImportedFolderToProject,
  type RepositoryMetadataOwner
} from '../../workspaces/catalog/imported-folder-project-link'
import { readCurrentGitRemoteIdentity } from '../../workspaces/catalog/repo-git-remote-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import { updateProjectHostSetupWithProvenKind } from '../../workspaces/catalog/folder-repo-git-conversion'
import { repointMovedFolderProject } from '../../workspaces/catalog/folder-project-repoint'
import { invalidateAuthorizedRootsCache } from '../worktrees/removal/registered-worktree-roots-cache'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'
import {
  ProjectHostSetupCreateIpcArgs,
  ProjectHostSetupDeleteIpcArgs,
  ProjectHostSetupExistingFolderIpcArgs,
  ProjectHostSetupUpdateIpcArgs,
  parseProjectGroupIpcArgs
} from './repo-ipc-arg-schemas'
import { addLocalRepoFromPath } from './local-repo-registration'
import { sshHostWithoutServerMessage } from '../../../shared/project-host-setup-target'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import {
  assertWslMoveHostSetupIdWritable,
  assertWslMoveHostSetupWritable
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

function buildProjectHostSetupResult(store: Store, repo: Repo): ProjectHostSetupResult {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  const project = store.getProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}

export function registerProjectHostSetupHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  metadata: RepositoryMetadataOwner
): void {
  ipcMain.handle(
    'projectHostSetups:create',
    (_event, rawArgs: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupCreateIpcArgs,
        rawArgs,
        'project_host_setup_create_invalid_args'
      )
      assertWslMoveHostSetupWritable(store, args)
      const result = store.createProjectHostSetup(args)
      if (!result) {
        throw new Error(`Project not found: ${args.projectId}`)
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:update',
    async (_event, rawArgs: ProjectHostSetupUpdateArgs): Promise<ProjectHostSetupUpdateResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupUpdateIpcArgs,
        rawArgs,
        'project_host_setup_update_invalid_args'
      )
      assertWslMoveHostSetupIdWritable(store, args)
      const result = await updateProjectHostSetupWithProvenKind(
        store,
        (setupArgs) => {
          assertWslMoveHostSetupIdWritable(store, setupArgs)
          return store.updateProjectHostSetup(setupArgs)
        },
        args
      )
      if (!result) {
        throw new Error(`Project host setup not found: ${args.setupId}`)
      }
      if ('worktreeBasePath' in args.updates && result.repo) {
        void prepareLocalWorktreeRootForRepo(store, result.repo)
        invalidateAuthorizedRootsCache()
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:delete',
    (_event, rawArgs: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupDeleteIpcArgs,
        rawArgs,
        'project_host_setup_delete_invalid_args'
      )
      assertWslMoveHostSetupIdWritable(store, args)
      const result = store.deleteProjectHostSetup(args)
      if (!result) {
        throw new Error(`Project host setup not found: ${args.setupId}`)
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:setupExistingFolder',
    async (
      _event,
      rawArgs: ProjectHostSetupExistingFolderArgs
    ): Promise<ProjectHostSetupResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupExistingFolderIpcArgs,
        rawArgs,
        'project_host_setup_invalid_args'
      )
      const parsedHost = parseExecutionHostId(args.hostId)
      if (!parsedHost) {
        throw new Error(`Unsupported host: ${args.hostId}`)
      }
      // A folder project whose folder moved is repointed in place instead of duplicated (#30807).
      if (parsedHost.kind === 'local') {
        // The same fence the ordinary import path runs: a project mid-WSL-move must not be repointed.
        const localRepoId = repoIdForHostLocalProjectId(args.projectId)
        assertWslMoveHostSetupWritable(store, {
          projectId: args.projectId,
          hostId: args.hostId,
          ...(localRepoId ? { repoId: localRepoId } : {})
        })
        const repoint = await repointMovedFolderProject(store, {
          projectId: args.projectId,
          folderPath: args.path,
          kind: args.kind
        })
        if (repoint.outcome === 'repointed') {
          // A repointed row must not report the legacy default when the caller named its method.
          const repointed = repoint.repo.projectHostSetupMethod
            ? repoint.repo
            : store.updateRepo(repoint.repo, {
                projectHostSetupMethod: args.setupMethod ?? 'imported-existing-folder'
              })
          if (!repointed) {
            throw new Error(
              `Project setup repo disappeared before its method could be set: ${repoint.repo.id}`
            )
          }
          invalidateAuthorizedRootsCache()
          notifyReposChanged(mainWindow)
          return buildProjectHostSetupResult(store, repointed)
        }
        if (repoint.outcome === 'refused') {
          throw new Error(repoint.reason)
        }
      }
      const result =
        parsedHost.kind === 'local'
          ? await addLocalRepoFromPath(store, args.path, args.kind)
          : parsedHost.kind === 'ssh'
            ? {
                error: sshHostWithoutServerMessage(
                  getSshTargetRegistryStore()?.getTarget(parsedHost.targetId)?.label ??
                    parsedHost.targetId
                )
              }
            : {
                error:
                  'Runtime hosts must be set up through the runtime projectHostSetup.setupExistingFolder RPC.'
              }
      if ('error' in result) {
        throw new Error(result.error)
      }
      // Stored remotes may predate changes made in the checkout.
      const folderRemote =
        result.alreadyExisted || result.repo.gitRemoteIdentity === undefined
          ? await readCurrentGitRemoteIdentity(result.repo)
          : result.repo
      let aligned: ProjectHostSetupResult
      try {
        const repo = await linkImportedFolderToProject(
          () => store,
          result.repo,
          folderRemote,
          { ...args, hostId: getRepoExecutionHostId(result.repo) },
          metadata
        )
        aligned = buildProjectHostSetupResult(store, repo)
      } catch (err) {
        // Failed linking must not leave a newly registered repo or authorization root.
        if (!result.alreadyExisted) {
          store.removeProjectForHost(result.repo)
          invalidateAuthorizedRootsCache()
        }
        notifyReposChanged(mainWindow)
        throw err
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted)
      if (result.alreadyExisted) {
        await prepareLocalWorktreeRootForRepo(store, aligned.repo)
      }
      return aligned
    }
  )
}
