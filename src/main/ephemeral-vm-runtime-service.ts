import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import {
  persistFailedEphemeralVmResume,
  validateEphemeralVmResumeIntegrity
} from './ephemeral-vm-resume-integrity'
import { stripGitRemoteUrlCredentials } from '../shared/git-remote-identity'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeSuspend,
  runEphemeralVmRecipeStart
} from './ephemeral-vm-recipe-runner'
import {
  getEphemeralVmRuntimeRecipeContext,
  getPersistedEphemeralVmRecipe
} from './ephemeral-vm-runtime-recipe-context'
import type {
  CleanupEphemeralVmRuntimeArgs,
  CleanupEphemeralVmRuntimeResult,
  ProvisionEphemeralVmRuntimeArgs,
  ProvisionEphemeralVmRuntimeResult,
  ResumeEphemeralVmRuntimeResult,
  SuspendEphemeralVmRuntimeResult
} from './ephemeral-vm-runtime-service-types'
export type * from './ephemeral-vm-runtime-service-types'

const cleanupInFlight = new Map<string, Promise<CleanupEphemeralVmRuntimeResult>>()

export async function provisionEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs
): Promise<ProvisionEphemeralVmRuntimeResult> {
  const repoUrl = stripGitRemoteUrlCredentials(args.repoUrl ?? '') ?? undefined
  const start = await runEphemeralVmRecipeStart({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: {
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      repoUrl,
      branch: args.branch,
      ref: args.ref,
      orcaVersion: args.orcaVersion
    },
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })
  if (!start.ok) {
    if (start.recipeResult) {
      await runEphemeralVmRecipeCleanup({
        repoPath: args.repoPath,
        recipe: args.recipe,
        context: start.context,
        recipeResult: start.recipeResult,
        signal: args.signal,
        onStdout: args.onStdout,
        onStderr: args.onStderr
      }).catch(() => undefined)
    }
    return { ok: false, start }
  }

  const now = args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  const runtime = upsertEphemeralVmRuntime(args.userDataPath, {
    id: start.context.instanceId ?? start.context.recipeId,
    recipeId: args.recipe.id,
    recipe: getPersistedEphemeralVmRecipe(args.recipe),
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.orcaVersion ? { orcaVersion: args.orcaVersion } : {}),
    ...(args.recipe.checkoutMode === 'provisioned-root'
      ? { provisionedProjectRoot: getEphemeralVmRecipeResultProjectRoot(start.result) }
      : {}),
    status: 'running',
    connectionMode: connection.type,
    cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'not_started',
    ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
    createdAt: now,
    updatedAt: now,
    recipeResult: start.result
  })

  return { ok: true, start, runtime }
}

export function cleanupEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  const key = `${args.userDataPath}\0${args.runtimeId}`
  const existing = cleanupInFlight.get(key)
  if (existing) {
    return existing
  }
  const cleanup = cleanupEphemeralVmRuntimeOnce(args)
  cleanupInFlight.set(key, cleanup)
  const forget = (): void => {
    if (cleanupInFlight.get(key) === cleanup) {
      cleanupInFlight.delete(key)
    }
  }
  void cleanup.then(forget, forget)
  return cleanup
}

async function cleanupEphemeralVmRuntimeOnce(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  if (existing.status === 'cleaned') {
    return {
      ok: true,
      runtime: existing,
      skipped: existing.cleanupStatus === 'disabled'
    }
  }

  const now = args.now ?? Date.now()
  const running = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'cleanup_pending',
    cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'running',
    cleanupLastAttemptAt: now,
    cleanupLastError: null,
    updatedAt: now
  })
  const cleanup = await runEphemeralVmRecipeCleanup({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: getEphemeralVmRuntimeRecipeContext(args.repoPath, running),
    recipeResult: running.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!cleanup.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: cleanup.error ?? 'Destroy failed.',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: cleanup.error ?? 'Destroy failed.' }
  }

  const cleaned = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'cleaned',
    cleanupStatus: cleanup.skipped ? 'disabled' : 'succeeded',
    cleanupLastError: null,
    updatedAt: Date.now()
  })
  return { ok: true, runtime: cleaned, skipped: cleanup.skipped }
}

export async function suspendEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<SuspendEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  const suspend = await runEphemeralVmRecipeSuspend({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: getEphemeralVmRuntimeRecipeContext(args.repoPath, existing),
    recipeResult: existing.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!suspend.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'suspend_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: suspend.error ?? 'Suspend failed.' }
  }

  const suspended = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: suspend.skipped ? existing.status : 'suspended',
    updatedAt: Date.now()
  })
  return { ok: true, runtime: suspended, skipped: suspend.skipped }
}

export async function resumeEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<ResumeEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  const resume = await runEphemeralVmRecipeResume({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: getEphemeralVmRuntimeRecipeContext(args.repoPath, existing),
    recipeResult: existing.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!resume.ok) {
    return persistFailedEphemeralVmResume({
      userDataPath: args.userDataPath,
      existing,
      error: resume.error,
      recipeResult: resume.recipeResult
    })
  }

  if (!resume.skipped) {
    const integrity = validateEphemeralVmResumeIntegrity({
      userDataPath: args.userDataPath,
      existing,
      resume
    })
    if (!integrity.ok) {
      return integrity
    }
  }

  const runtime = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'running',
    ...(!resume.skipped ? { recipeResult: resume.result } : {}),
    resumeConnectionPending: !resume.skipped,
    updatedAt: Date.now()
  })
  return { ok: true, runtime, skipped: resume.skipped }
}
