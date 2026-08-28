import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { ExecutionHostId } from '../shared/execution-host'
import type { ProjectProviderIdentity } from '../shared/project-types'
import type { CreateWorktreeResult } from '../shared/worktree/create-types'
import { toSshExecutionHostId } from '../shared/execution-host'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../shared/ephemeral-vm-recipe-repo-url'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm-runtime-ssh-cleanup'
import {
  connectRuntimeOwnedSshTarget,
  removeRuntimeOwnedSshTarget
} from './ephemeral-vm-runtime-ssh'
import { getRuntimeRecipeContext, resolveRecipeForRepo } from './ipc/ephemeral-vm-recipe-context'
import { addRemoteRepoFromPath } from './ipc/repos/remote-repo-registration'
import { alignRepoWithRequestedProject } from './ipc/repos/project-host-setup-handlers'
import { invalidateAuthorizedRootsCache } from './ipc/registered-worktree-roots-cache'
import { resolveProvisionedRootSource } from './ephemeral-vm-provisioned-root-source'
import {
  adoptProvisionedRootSshCheckout,
  type ProvisionedRootAdoptionRequest
} from './provisioned-root-ssh-adoption'

export type ProvisionedRootRecipeWorkspaceDeps = {
  userDataPath: string
  store: Store
  getApprovedPluginRecipes: () => Promise<readonly OrcaVmRecipe[]>
  isRepoCurrent: (repo: Repo, executionHostId?: ExecutionHostId) => boolean
  onRepoRegistered?: () => void
}

export type ProvisionedRootRecipeWorkspaceArgs = {
  /** Local source checkout whose orca.yaml owns the recipe. */
  repo: Repo
  recipeId: string
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  branchName: string
  baseBranch?: string
  request: Omit<
    ProvisionedRootAdoptionRequest,
    'repoId' | 'runtimeId' | 'executionHostId' | 'expectedPath' | 'expectedRefHead'
  >
  onStderr?: (chunk: string) => void
}

export type ProvisionedRootRecipeWorkspaceCreation = {
  result: CreateWorktreeResult
  runtimeId: string
  sshTargetId: string
  warnings: EphemeralVmRecipeResultWarning[]
}

/** Runs the recipe destroy for every live runtime attached to a removed workspace — the RPC-side
 *  counterpart of the renderer's delete-flow cleanup, which never runs for CLI/mobile removals. */
export async function cleanupRecipeRuntimesForWorkspace(
  deps: Pick<ProvisionedRootRecipeWorkspaceDeps, 'userDataPath' | 'store'>,
  workspaceId: string
): Promise<void> {
  const targets = listEphemeralVmRuntimes(deps.userDataPath).filter(
    (runtime) =>
      runtime.workspaceId === workspaceId &&
      (runtime.cleanupStatus !== 'succeeded' || runtime.sshTargetId !== undefined)
  )
  for (const target of targets) {
    if (target.cleanupStatus !== 'succeeded') {
      const context = getRuntimeRecipeContext(deps.store, deps.userDataPath, target.id)
      await cleanupEphemeralVmRuntime({
        userDataPath: deps.userDataPath,
        repoPath: context.repo.repo.path,
        recipe: context.recipe,
        runtimeId: target.id
      })
    }
    await removeEphemeralVmRuntimeSshTarget({
      userDataPath: deps.userDataPath,
      runtime: target,
      removeTarget: removeRuntimeOwnedSshTarget
    })
  }
}

/** The CLI/RPC equivalent of the desktop composer's "Run on: <recipe>" flow: run the recipe's
 *  create script, connect its SSH target, register the remote root, and adopt it as the
 *  workspace. Terminal startup and lineage stay with the caller. */
export async function createProvisionedRootRecipeWorkspace(
  deps: ProvisionedRootRecipeWorkspaceDeps,
  args: ProvisionedRootRecipeWorkspaceArgs
): Promise<ProvisionedRootRecipeWorkspaceCreation> {
  const recipe = resolveRecipeForRepo(
    args.repo.path,
    args.recipeId,
    await deps.getApprovedPluginRecipes()
  )
  if (!recipe) {
    throw new Error(`Recipe not found: ${args.recipeId}`)
  }
  if (recipe.checkoutMode !== 'provisioned-root') {
    // Portable recipes pair an in-VM Orca server whose transport only the desktop client owns.
    throw new Error(
      `Recipe ${args.recipeId} is not a provisioned-root recipe. Only provisioned-root (SSH) recipes can create workspaces here; use the desktop app for this recipe.`
    )
  }
  if (args.request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }

  const source = await resolveProvisionedRootSource(deps.store, args.repo, args.baseBranch)
  if (!source) {
    throw new Error(
      args.baseBranch
        ? `Could not resolve provisioned-root start ref: ${args.baseBranch}`
        : 'Could not resolve a default provisioned-root start ref.'
    )
  }

  const repoUrl = getProvisionedRootRecipeRepoUrl(
    recipe.checkoutMode,
    source.remoteUrl ?? args.repo.gitRemoteIdentity?.remoteUrl
  )
  const provisioned = await provisionEphemeralVmRuntime({
    userDataPath: deps.userDataPath,
    repoPath: args.repo.path,
    repoId: args.repo.id,
    recipe,
    projectId: args.projectId,
    workspaceName: args.request.name,
    ...(repoUrl ? { repoUrl } : {}),
    branch: args.branchName,
    ref: source.ref,
    expectedRefHead: source.head,
    onStderr: args.onStderr
  })
  if (!provisioned.ok) {
    const stderr = redactEphemeralVmRecipeDiagnosticText(provisioned.start.stderr).trim()
    throw new Error(
      stderr ? `${provisioned.start.error}\n${stderr}` : provisioned.start.error
    )
  }
  const runtimeId = provisioned.runtime.id
  const cleanupProvisioned = async (): Promise<void> => {
    const cleaned = await cleanupEphemeralVmRuntime({
      userDataPath: deps.userDataPath,
      repoPath: args.repo.path,
      recipe,
      runtimeId
    }).catch(() => undefined)
    if (cleaned?.runtime.sshTargetId) {
      await removeEphemeralVmRuntimeSshTarget({
        userDataPath: deps.userDataPath,
        runtime: cleaned.runtime,
        removeTarget: removeRuntimeOwnedSshTarget
      }).catch(() => undefined)
    }
  }

  const connection = getEphemeralVmRecipeResultConnection(provisioned.start.result)
  if (connection.type !== 'ssh') {
    await cleanupProvisioned()
    throw new Error('Provisioned-root recipes currently require a direct SSH connection.')
  }

  let sshTargetId: string
  try {
    const ssh = await connectRuntimeOwnedSshTarget({ runtimeId, connection })
    sshTargetId = ssh.targetId
  } catch (error) {
    await cleanupProvisioned()
    throw error
  }
  updateEphemeralVmRuntimeStatus(deps.userDataPath, runtimeId, { sshTargetId })
  const executionHostId = toSshExecutionHostId(sshTargetId)

  try {
    const setup = await registerProvisionedRootRepo(deps, args, sshTargetId, connection.projectRoot)
    const result = await adoptProvisionedRootSshCheckout({
      userDataPath: deps.userDataPath,
      request: {
        ...args.request,
        repoId: setup.repo.id,
        branchNameOverride: args.branchName,
        ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
        runtimeId,
        executionHostId,
        expectedPath: connection.projectRoot,
        expectedRefHead: source.head
      },
      repo: setup.repo,
      store: deps.store,
      isRepoCurrent: () => deps.isRepoCurrent(setup.repo, executionHostId)
    })
    return {
      result,
      runtimeId,
      sshTargetId,
      warnings: getEphemeralVmRecipeResultWarnings(provisioned.start.result)
    }
  } catch (error) {
    // cleanup runs the recipe destroy and detaches the runtime-owned SSH target.
    await cleanupProvisioned()
    throw error
  }
}

/** The SSH half of the renderer's `setupExistingFolder` flow: register the remote checkout and
 *  link it to the source repo's project, rolling back a fresh registration on link failure. */
async function registerProvisionedRootRepo(
  deps: ProvisionedRootRecipeWorkspaceDeps,
  args: ProvisionedRootRecipeWorkspaceArgs,
  sshTargetId: string,
  projectRoot: string
): Promise<{ repo: Repo }> {
  const registration = await addRemoteRepoFromPath(deps.store, {
    connectionId: sshTargetId,
    remotePath: projectRoot,
    kind: 'git'
  })
  if ('error' in registration) {
    throw new Error(registration.error)
  }
  try {
    const aligned = alignRepoWithRequestedProject(
      deps.store,
      registration.repo,
      args.projectId,
      'imported-existing-folder',
      args.projectProviderIdentity
    )
    invalidateAuthorizedRootsCache()
    deps.onRepoRegistered?.()
    return { repo: aligned.repo }
  } catch (error) {
    // Why: a failed link must not leave a new repo registration or authorization root behind.
    if (!registration.alreadyExisted) {
      deps.store.removeProject(registration.repo.id)
      invalidateAuthorizedRootsCache()
    }
    throw error
  }
}
