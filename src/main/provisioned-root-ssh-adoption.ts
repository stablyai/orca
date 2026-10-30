import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeResult
} from '../shared/worktree/create-types'
import type { AutomationWorkspaceProvenance } from '../shared/worktree/types'
import { isRuntimeOwnedSshTargetId, toSshExecutionHostId } from '../shared/execution-host'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { provisionedRootPathsEqual } from './provisioned-root-checkout'

type AdoptionArgs = AdoptProvisionedRootArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}

export async function adoptProvisionedRootSshCheckout(args: {
  userDataPath: string
  request: AdoptionArgs
  repo: Repo
  store: Store
  isRepoCurrent: () => boolean
}): Promise<CreateWorktreeResult> {
  const { request, repo } = args
  if (request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  const connectionId = repo.connectionId
  if (!connectionId || !isRuntimeOwnedSshTargetId(connectionId)) {
    throw new Error('Provisioned-root adoption requires a runtime-owned SSH target.')
  }
  if (request.executionHostId !== toSshExecutionHostId(connectionId)) {
    throw new Error('Provisioned-root workspace host does not match its SSH target.')
  }

  const runtime = requireOwnedProvisionedRootRuntime(
    args.userDataPath,
    request.runtimeId,
    connectionId
  )
  const projectRoot = getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)
  if (
    !provisionedRootPathsEqual(request.expectedPath, projectRoot) ||
    !provisionedRootPathsEqual(repo.path, projectRoot)
  ) {
    throw new Error('The recipe projectRoot does not match the imported Git checkout root.')
  }

  // This process cannot adopt SSH checkouts because it serves no SSH Git.
  throw new Error('The recipe-created SSH connection is no longer available.')
}

function requireOwnedProvisionedRootRuntime(
  userDataPath: string,
  runtimeId: string,
  connectionId: string
): EphemeralVmRuntimeRecord {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (
    runtime.connectionMode !== 'ssh' ||
    runtime.sshTargetId !== connectionId ||
    runtime.recipe?.checkoutMode !== 'provisioned-root' ||
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) !== 'provisioned-root' ||
    ['cleanup_pending', 'cleanup_failed', 'cleaned'].includes(runtime.status)
  ) {
    throw new Error('The ephemeral VM runtime does not own this provisioned SSH checkout.')
  }
  return runtime
}
