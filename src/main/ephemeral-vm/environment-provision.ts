import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../../shared/ephemeral-vm-recipe-repo-url'
import { updateEphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtime-store'
import {
  requireEphemeralVmRecipeResult,
  type EphemeralVmProvisionedRuntimeRecord
} from '../../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  ephemeralVmFailure,
  pickEphemeralVmFailureCode,
  type EphemeralVmFailure
} from '../../shared/ephemeral-vm-failure-copy'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getRecipeRepo, resolveRecipeForRepo } from '../ipc/ephemeral-vm-recipe-context'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import { cleanupEphemeralVmRuntime, provisionEphemeralVmRuntime } from './runtime-service'
import { connectRuntimeOwnedSshTarget } from './runtime-ssh'
import { resolveProvisionedRootSource } from './provisioned-root-source'

export type EphemeralVmProvisionIpcResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmProvisionedRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmProvisionedRuntimeRecord
      sshTargetId: string
      /** The managed Orca server the host runs; its workspace lives there. */
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | ({
      ok: false
      stderr: string
      stdout: string
    } & EphemeralVmFailure)

/** Named steps of provisioning, reported to callers that show progress. */
export type RecipeEnvironmentProvisionPhase =
  | 'resolving-start-ref'
  | 'running-create'
  | 'connecting'

export type RecipeEnvironmentProvisionArgs = {
  repoId: string
  recipeId: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
}

function provisionFailure(failure: EphemeralVmFailure): EphemeralVmProvisionIpcResult {
  return { ok: false, ...failure, stdout: '', stderr: '' }
}

/** Shared by the desktop IPC handler and CLI `worktree create --recipe`. */
export async function provisionRecipeEnvironment(
  store: Store,
  userDataPath: string,
  args: RecipeEnvironmentProvisionArgs,
  pluginRecipes: readonly OrcaVmRecipe[],
  options: {
    /** A caller that already resolved the repo by host passes it; an id lookup could pick another host's twin. */
    repo?: Repo
    /** A caller that already resolved the recipe passes it, so one orca.yaml read decides the run. */
    recipe?: OrcaVmRecipe
    signal?: AbortSignal
    onPhase?: (phase: RecipeEnvironmentProvisionPhase) => void
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
  } = {}
): Promise<EphemeralVmProvisionIpcResult> {
  const repo = options.repo
    ? ({ ok: true, repo: options.repo } as const)
    : getRecipeRepo(store, args.repoId)
  if (!repo.ok) {
    return provisionFailure(repo.failure)
  }
  const recipe =
    options.recipe ?? resolveRecipeForRepo(repo.repo.path, args.recipeId, pluginRecipes)
  if (!recipe) {
    return provisionFailure(ephemeralVmFailure('recipeNotFound', { recipeId: args.recipeId }))
  }
  let recipeRepoUrl = repo.repo.gitRemoteIdentity?.remoteUrl
  let sourceRef = args.ref
  let expectedRefHead: string | undefined
  if (recipe.checkoutMode === 'provisioned-root') {
    options.onPhase?.('resolving-start-ref')
    const source = await resolveProvisionedRootSource(store, repo.repo, args.ref, options.signal)
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
    repoPath: repo.repo.path,
    repoId: repo.repo.id,
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
  const cleanupAndFail = async (error: unknown): Promise<EphemeralVmProvisionIpcResult> => {
    await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: repo.repo.path,
      recipe,
      runtimeId: result.runtime.id
    }).catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
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
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    } catch (error) {
      return cleanupAndFail(error)
    }
  }

  let environment: ReturnType<typeof addEnvironmentFromPairingCode>
  try {
    environment = addEnvironmentFromPairingCode(getRuntimeEnvironmentRegistryRoot(), {
      name: buildEphemeralEnvironmentName(repo.repo.displayName, result.runtime.id),
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
  } catch (error) {
    return cleanupAndFail(error)
  }
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
    stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
    warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
  }
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
