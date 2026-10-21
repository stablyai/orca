import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
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
import { resolveImportedFolderProjectLink } from '../../../shared/imported-folder-project-identity'
import { readCurrentGitRemoteIdentity } from '../../repo-git-remote-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { updateProjectHostSetupWithProvenKind } from '../../folder-repo-git-conversion'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
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
import { sshTargetNotConnectedMessage } from '../../providers/ssh-host-not-served-error'
import {
  assertWslMoveHostSetupIdWritable,
  assertWslMoveHostSetupWritable
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

function buildProjectHostSetupResult(store: Store, repo: Repo): ProjectHostSetupResult {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  const project = store.getProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}

function alignRepoWithRequestedProject(
  store: Store,
  repo: Repo,
  folderRemote: Pick<Repo, 'gitRemoteIdentity'>,
  projectId: string,
  setupMethod: ProjectHostSetupExistingFolderArgs['setupMethod'] = 'imported-existing-folder',
  requestedProviderIdentity?: ProjectHostSetupExistingFolderArgs['projectProviderIdentity']
): ProjectHostSetupResult {
  assertWslMoveHostSetupWritable(store, {
    projectId,
    hostId: getRepoExecutionHostId(repo),
    repoId: repo.id
  })
  let setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  if (setup.projectId !== projectId) {
    const project = store.getProjects().find((entry) => entry.id === projectId)
    // Why: the selected project can exist only on the source host, so its structured identity travels with the request.
    const updated = store.updateRepo(
      repo,
      resolveImportedFolderProjectLink(
        folderRemote,
        projectId,
        project?.providerIdentity ?? requestedProviderIdentity
      )
    )
    if (!updated) {
      throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
    }
    repo = updated
    setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  }
  const updated = store.updateRepo(repo, { projectHostSetupMethod: setupMethod })
  if (!updated) {
    throw new Error(
      `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`
    )
  }
  repo = updated
  return buildProjectHostSetupResult(store, repo)
}

export function registerProjectHostSetupHandlers(mainWindow: BrowserWindow, store: Store): void {
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
      const result =
        parsedHost.kind === 'local'
          ? await addLocalRepoFromPath(store, args.path, args.kind)
          : parsedHost.kind === 'ssh'
            ? { error: sshTargetNotConnectedMessage(parsedHost.targetId) }
            : {
                error:
                  'Runtime hosts must be set up through the runtime projectHostSetup.setupExistingFolder RPC.'
              }
      if ('error' in result) {
        throw new Error(result.error)
      }
      // Why: a registered row's stored remote can predate a remote the user has since added.
      const folderRemote =
        result.alreadyExisted || result.repo.gitRemoteIdentity === undefined
          ? await readCurrentGitRemoteIdentity(result.repo)
          : result.repo
      let aligned: ProjectHostSetupResult
      try {
        aligned = alignRepoWithRequestedProject(
          store,
          result.repo,
          folderRemote,
          args.projectId,
          args.setupMethod,
          args.projectProviderIdentity
        )
      } catch (err) {
        // Why: an import that cannot be linked must not leave a new repo registration or authorization root behind.
        if (!result.alreadyExisted) {
          store.removeProjectForHost(result.repo)
          invalidateAuthorizedRootsCache()
        }
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
