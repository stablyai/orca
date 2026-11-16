import type { Store } from '../persistence/loading-store/store'
import type { OrcaVmRecipe } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { getEphemeralVmRecipeResultConnection } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipes'
import { getEphemeralVmRecipeResultWarnings } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostics'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostic-redaction'
import { getProvisionedRootRecipeRepoUrl } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-repo-url'
import { updateEphemeralVmRuntimeStatus } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
import { requireEphemeralVmRecipeResult } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { redactRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  ephemeralVmFailure,
  pickEphemeralVmFailureCode,
  type EphemeralVmFailure
} from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-failure-copy'
import type {
  RecipeEnvironmentProvisionPhase,
  RecipeEnvironmentProvisionResult
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-environment-provision-result'
import {
  getRecipeRepo,
  resolveRecipeForRepo,
  type RecipeRepoResult
} from '../ipc/ephemeral-vm-recipe-context'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { cleanupEphemeralVmRuntime, provisionEphemeralVmRuntime } from './runtime-service'
import { connectRuntimeOwnedSshTarget } from './runtime-ssh'
import { resolveProvisionedRootSource } from './provisioned-root-source'

type RecipeRepo = Extract<RecipeRepoResult, { ok: true }>['repo']

export type RecipeProvisionTarget = { repo: RecipeRepo; recipe: OrcaVmRecipe }

export type RecipeEnvironmentProvisionArgs = {
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
}

export function provisionFailure(failure: EphemeralVmFailure): RecipeEnvironmentProvisionResult {
  return { ok: false, ...failure, stdout: '', stderr: '' }
}

/** The local repo and the recipe a provision runs; a failure is the answer to return as is. */
export function resolveRecipeProvisionTarget(
  store: Store,
  repoId: string,
  recipeId: string,
  recipes: readonly OrcaVmRecipe[]
):
  | { ok: true; target: RecipeProvisionTarget }
  | { ok: false; result: RecipeEnvironmentProvisionResult } {
  const repo = getRecipeRepo(store, repoId)
  if (!repo.ok) {
    return { ok: false, result: provisionFailure(repo.failure) }
  }
  const recipe = resolveRecipeForRepo(repo.repo.path, recipeId, recipes)
  if (!recipe) {
    return {
      ok: false,
      result: provisionFailure(ephemeralVmFailure('recipeNotFound', { recipeId }))
    }
  }
  return { ok: true, target: { repo: repo.repo, recipe } }
}

/**
 * Runs a recipe's create step and connects Orca to what it made: the runtime-owned SSH target for
 * SSH recipes, a paired environment for orca-server ones. The new-workspace dialog (through IPC)
 * and `orca worktree create --on recipe:<id>` share it. A failure after the VM exists destroys it.
 */
export async function provisionRecipeEnvironment(
  store: Store,
  userDataPath: string,
  { repo, recipe }: RecipeProvisionTarget,
  args: RecipeEnvironmentProvisionArgs,
  options: {
    signal?: AbortSignal
    onPhase?: (phase: RecipeEnvironmentProvisionPhase) => void
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
  } = {}
): Promise<RecipeEnvironmentProvisionResult> {
  let recipeRepoUrl = repo.gitRemoteIdentity?.remoteUrl
  let sourceRef = args.ref
  let expectedRefHead: string | undefined
  if (recipe.checkoutMode === 'provisioned-root') {
    options.onPhase?.('resolving-start-ref')
    const source = await resolveProvisionedRootSource(store, repo, args.ref, options.signal)
    if (options.signal?.aborted) {
      return provisionFailure(ephemeralVmFailure('provisionCancelled'))
    }
    if (!source) {
      return provisionFailure(
        args.ref
          ? ephemeralVmFailure('startRefUnresolved', { ref: args.ref })
          : ephemeralVmFailure('defaultStartRefUnresolved')
      )
    }
    sourceRef = source.ref
    expectedRefHead = source.head
    recipeRepoUrl = source.remoteUrl ?? recipeRepoUrl
  }
  const repoUrl = getProvisionedRootRecipeRepoUrl(recipe.checkoutMode, recipeRepoUrl)
  options.onPhase?.('running-create')
  const result = await provisionEphemeralVmRuntime({
    userDataPath,
    repoPath: repo.path,
    repoId: repo.id,
    recipe,
    projectId: args.projectId,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    ...(repoUrl ? { repoUrl } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(sourceRef ? { ref: sourceRef } : {}),
    ...(expectedRefHead ? { expectedRefHead } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onStdout: options.onStdout,
    onStderr: options.onStderr
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.start.error,
      ...pickEphemeralVmFailureCode(result.start),
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const stdout = redactEphemeralVmRecipeDiagnosticText(result.start.stdout)
  const stderr = redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
  const destroyAndFail = async (error: unknown): Promise<RecipeEnvironmentProvisionResult> => {
    const cleaned = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: repo.path,
      recipe,
      runtimeId: result.runtime.id
    }).catch(() => null)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      runtimeId: result.runtime.id,
      environmentCleanup: !cleaned?.ok ? 'failed' : cleaned.skipped ? 'disabled' : 'destroyed',
      stdout,
      stderr
    }
  }
  options.onPhase?.('connecting')
  const connection = getEphemeralVmRecipeResultConnection(result.start.result)
  if (connection.type === 'ssh') {
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection
      })
      const runtime = requireEphemeralVmRecipeResult(
        updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
          sshTargetId: ssh.targetId,
          runtimeEnvironmentId: ssh.environmentId
        })
      )
      return {
        ok: true,
        connectionType: 'ssh',
        runtime,
        sshTargetId: ssh.targetId,
        environmentId: ssh.environmentId,
        ...(expectedRefHead ? { expectedRefHead } : {}),
        stderr,
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    } catch (error) {
      return destroyAndFail(error)
    }
  }

  try {
    const environment = await addEnvironmentFromPairingCode(getRuntimeEnvironmentRegistryRoot(), {
      name: buildEphemeralEnvironmentName(repo.displayName, result.runtime.id),
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
    // Why inside the try: a VM whose record update fails must still be destroyed.
    const runtime = requireEphemeralVmRecipeResult(
      updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        runtimeEnvironmentId: environment.id
      })
    )
    return {
      ok: true,
      connectionType: 'orca-server',
      runtime,
      environment: redactRuntimeEnvironment(environment),
      stderr,
      warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
    }
  } catch (error) {
    return destroyAndFail(error)
  }
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
