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
import {
  getCarriedCheckoutIdentityKey,
  getProjectIdentityKey,
  getProjectIdForProviderIdentity
} from '../../../shared/project-host-setup-projection'
import { addsCheckoutOrigin } from '../../../shared/git-remote-identity'
import { getProjectHostSetupForRepo } from '../../../shared/project-host-setup-lookup'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
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
import { addRemoteRepoFromPath } from './remote-repo-registration'

/**
 * The IPC reply for a registered repo. A setup whose project row is missing is a store invariant
 * breach, so it throws instead of replying with a half-built result.
 */
function buildProjectHostSetupResult(store: Store, repo: Repo): ProjectHostSetupResult {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  const project = store.getProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}

/**
 * Merges a freshly registered repo into the project the request named — stamping the ancestor
 * identity or the carried checkout identity — and refuses when no stamp makes the derived id match.
 */
function alignRepoWithRequestedProject(
  store: Store,
  repo: Repo,
  projectId: string,
  setupMethod: ProjectHostSetupExistingFolderArgs['setupMethod'] = 'imported-existing-folder',
  requestedProviderIdentity?: ProjectHostSetupExistingFolderArgs['projectProviderIdentity'],
  requestedGitRemoteIdentity?: ProjectHostSetupExistingFolderArgs['projectGitRemoteIdentity']
): ProjectHostSetupResult {
  let setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  if (setup.projectId !== projectId) {
    const project = store.getProjects().find((entry) => entry.id === projectId)
    // Why: the selected project can exist only on the source host, so its structured identity travels with the request.
    const identity = project?.providerIdentity ?? requestedProviderIdentity
    // Why: mirrors `identity` above for checkout-keyed projects, which have no provider identity —
    // the target host may not have the project record yet, so the request's copy is the only source.
    const checkoutIdentity = project?.gitRemoteIdentity ?? requestedGitRemoteIdentity
    if (identity && getProjectIdForProviderIdentity(identity) === projectId) {
      const upstream = {
        owner: identity.owner,
        repo: identity.repo,
        ...(identity.host ? { host: identity.host } : {})
      }
      // Why re-check before writing: a stale gitRemoteIdentity on the repo outranks upstream in
      // getProjectIdentityKey, so stamping first could leave a mismatched upstream behind on throw.
      if (getProjectIdentityKey({ ...repo, upstream }) !== projectId) {
        throw new Error('Imported folder does not match the selected project identity.')
      }
      // Why: stamp the selected project's provider identity when the folder lacks upstream, so projection can merge it.
      const updated = store.updateRepo(repo.id, { upstream })
      if (!updated) {
        throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
      }
      repo = updated
    } else if (
      checkoutIdentity &&
      (!repo.gitRemoteIdentity || addsCheckoutOrigin(repo.gitRemoteIdentity, checkoutIdentity)) &&
      getCarriedCheckoutIdentityKey(checkoutIdentity, identity) === projectId
    ) {
      // Why both: the checkout remote is what keys the project, and the ancestor metadata is what
      // qualifies a GHES id with its API port — the recheck below re-derives from the stored row.
      const updated = store.updateRepo(repo.id, {
        gitRemoteIdentity: checkoutIdentity,
        ...(identity
          ? {
              upstream: {
                owner: identity.owner,
                repo: identity.repo,
                ...(identity.host ? { host: identity.host } : {})
              }
            }
          : {})
      })
      if (!updated) {
        throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
      }
      repo = updated
    } else {
      throw new Error('Imported folder does not match the selected project identity.')
    }
    setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
    if (getProjectIdentityKey(repo) !== projectId) {
      throw new Error('Imported folder does not match the selected project identity.')
    }
  }
  const updated = store.updateRepo(repo.id, { projectHostSetupMethod: setupMethod })
  if (!updated) {
    throw new Error(
      `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`
    )
  }
  repo = updated
  return buildProjectHostSetupResult(store, repo)
}

/**
 * Local-host project setup IPC. A setup request carries the selected project's identity, so a
 * folder can join a project this host holds no record of yet.
 */
export function registerProjectHostSetupHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle(
    'projectHostSetups:create',
    (_event, rawArgs: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupCreateIpcArgs,
        rawArgs,
        'project_host_setup_create_invalid_args'
      )
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
    (_event, rawArgs: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupUpdateIpcArgs,
        rawArgs,
        'project_host_setup_update_invalid_args'
      )
      const result = store.updateProjectHostSetup(args)
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
            ? await addRemoteRepoFromPath(store, {
                connectionId: parsedHost.targetId,
                remotePath: args.path,
                displayName: args.displayName,
                kind: args.kind
              })
            : {
                error:
                  'Runtime hosts must be set up through the runtime projectHostSetup.setupExistingFolder RPC.'
              }
      if ('error' in result) {
        throw new Error(result.error)
      }
      let aligned: ProjectHostSetupResult
      try {
        aligned = alignRepoWithRequestedProject(
          store,
          result.repo,
          args.projectId,
          args.setupMethod,
          args.projectProviderIdentity,
          args.projectGitRemoteIdentity
        )
      } catch (err) {
        // Why: an import that cannot be linked must not leave a new repo registration or authorization root behind.
        if (!result.alreadyExisted) {
          store.removeProject(result.repo.id)
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
