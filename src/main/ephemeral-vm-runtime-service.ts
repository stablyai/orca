import type { OrcaVmRecipe } from '../shared/types'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeSuspend,
  runEphemeralVmRecipeStart,
  type EphemeralVmRecipeContext,
  type EphemeralVmRecipeStartFailure,
  type EphemeralVmRecipeStartSuccess
} from './ephemeral-vm-recipe-runner'

export type ProvisionEphemeralVmRuntimeArgs = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
  repoId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  repoUrl?: string
  branch?: string
  ref?: string
  orcaVersion?: string
  now?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type ProvisionEphemeralVmRuntimeResult =
  | {
      ok: true
      start: EphemeralVmRecipeStartSuccess
      runtime: EphemeralVmRuntimeRecord
    }
  | {
      ok: false
      start: EphemeralVmRecipeStartFailure
    }

export type CleanupEphemeralVmRuntimeArgs = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
  runtimeId: string
  now?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type CleanupEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export type SuspendEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export type ResumeEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export async function provisionEphemeralVmRuntime(
  args: ProvisionEphemeralVmRuntimeArgs
): Promise<ProvisionEphemeralVmRuntimeResult> {
  const start = await runEphemeralVmRecipeStart({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: {
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      repoUrl: args.repoUrl,
      branch: args.branch,
      ref: args.ref,
      orcaVersion: args.orcaVersion
    },
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })
  if (!start.ok) {
    return { ok: false, start }
  }

  const now = args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  const runtime = upsertEphemeralVmRuntime(args.userDataPath, {
    id: start.context.instanceId ?? start.context.recipeId,
    recipeId: args.recipe.id,
    recipe: args.recipe,
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
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

export async function cleanupEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
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
    context: contextFromRuntime(args.repoPath, running),
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
    context: contextFromRuntime(args.repoPath, existing),
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
    context: contextFromRuntime(args.repoPath, existing),
    recipeResult: existing.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!resume.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'resume_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: resume.error }
  }

  const runtime = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'running',
    ...(!resume.skipped ? { recipeResult: resume.result } : {}),
    updatedAt: Date.now()
  })
  return { ok: true, runtime, skipped: resume.skipped }
}

function contextFromRuntime(
  repoPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRecipeContext {
  return {
    instanceId: runtime.id,
    recipeId: runtime.recipeId,
    projectId: runtime.projectId,
    workspaceId: runtime.workspaceId,
    workspaceName: runtime.workspaceName,
    repoPath
  }
}
