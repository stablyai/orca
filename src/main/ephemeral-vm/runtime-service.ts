import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeSuspend,
  runEphemeralVmRecipeStart,
  type EphemeralVmRecipeContext,
  type EphemeralVmRecipeStartFailure,
  type EphemeralVmRecipeStartSuccess
} from '../../shared/ephemeral-vm-recipe-runner'
import {
  beginEphemeralVmProvisioning,
  endEphemeralVmProvisioning,
  isEphemeralVmProvisionLive,
  persistFailedEphemeralVmStart,
  persistProvisionedEphemeralVmRuntime
} from './runtime-provisioning-persistence'
import { getProvisionedRootResumeIntegrityError } from './resume-integrity'
import { runControlledEphemeralVmRuntimeCleanup } from './runtime-cleanup-control'
import {
  ephemeralVmFailure,
  pickEphemeralVmFailureCode
} from '../../shared/ephemeral-vm-failure-copy'

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
  expectedRefHead?: string
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
  const writeAhead = beginEphemeralVmProvisioning(args)
  try {
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
        expectedRefHead: args.expectedRefHead,
        orcaVersion: args.orcaVersion,
        instanceId: writeAhead.instanceId
      },
      signal: args.signal,
      onSpawn: () => {
        writeAhead.launched = true
      },
      onStdout: args.onStdout,
      onStderr: args.onStderr
    })
    if (!start.ok) {
      await persistFailedEphemeralVmStart(args, writeAhead, start)
      endEphemeralVmProvisioning(args, writeAhead)
      return { ok: false, start }
    }
    const runtime = await persistProvisionedEphemeralVmRuntime(args, start, writeAhead)
    endEphemeralVmProvisioning(args, writeAhead)
    return { ok: true, start, runtime }
  } catch (error) {
    endEphemeralVmProvisioning(args, writeAhead, error)
    throw error
  }
}

export function cleanupEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  return runControlledEphemeralVmRuntimeCleanup({
    userDataPath: args.userDataPath,
    runtimeId: args.runtimeId,
    signal: args.signal,
    run: (signal) => cleanupEphemeralVmRuntimeOnce({ ...args, signal })
  })
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
  if (existing.status === 'provisioning' && isEphemeralVmProvisionLive(existing.id)) {
    throw new Error(`Ephemeral VM runtime is still provisioning: ${existing.id}`)
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
    context: contextFromRuntime(args.repoPath, running),
    recipeResult: running.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!cleanup.ok) {
    const failure = cleanup.error
      ? { error: cleanup.error, ...pickEphemeralVmFailureCode(cleanup) }
      : ephemeralVmFailure('destroyFailed')
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: failure,
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: failure.error }
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
  if (!existing.recipeResult) {
    throw new Error(`Ephemeral VM runtime never finished provisioning: ${args.runtimeId}`)
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
  if (!existing.recipeResult) {
    throw new Error(`Ephemeral VM runtime never finished provisioning: ${args.runtimeId}`)
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

  const resumeIntegrityError = resume.skipped
    ? null
    : getProvisionedRootResumeIntegrityError(existing.recipeResult, resume.result)
  if (resumeIntegrityError) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'resume_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: resumeIntegrityError }
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
