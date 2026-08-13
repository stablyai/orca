import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { EphemeralVmRecipeResult } from '../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeStartSuccess } from '../shared/ephemeral-vm-recipe-runner'

export type EphemeralVmResumeIntegrityResult =
  | { ok: true }
  | { ok: false; runtime: EphemeralVmRuntimeRecord; error: string }
type EphemeralVmResumeIntegrityFailure = Extract<EphemeralVmResumeIntegrityResult, { ok: false }>

function ownsProvisionedRoot(runtime: EphemeralVmRuntimeRecord): boolean {
  return (
    runtime.provisionedProjectRoot !== undefined ||
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) === 'provisioned-root'
  )
}

export function validateEphemeralVmResumeIntegrity(args: {
  userDataPath: string
  existing: EphemeralVmRuntimeRecord
  resume: EphemeralVmRecipeStartSuccess
}): EphemeralVmResumeIntegrityResult {
  const { existing, resume } = args
  const resumedConnection = getEphemeralVmRecipeResultConnection(resume.result)
  if (existing.connectionMode && resumedConnection.type !== existing.connectionMode) {
    return failResumeIntegrity(
      args.userDataPath,
      existing,
      resume,
      'An ephemeral VM recipe must keep its connection type stable after resume.'
    )
  }
  const provisionedRoot =
    existing.provisionedProjectRoot ?? getEphemeralVmRecipeResultProjectRoot(existing.recipeResult)
  if (
    ownsProvisionedRoot(existing) &&
    normalizeRuntimePathForComparison(provisionedRoot) !==
      normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(resume.result))
  ) {
    return failResumeIntegrity(
      args.userDataPath,
      existing,
      resume,
      'A provisioned-root recipe must keep projectRoot stable after resume.',
      provisionedRoot
    )
  }
  return { ok: true }
}

export function persistFailedEphemeralVmResume(args: {
  userDataPath: string
  existing: EphemeralVmRuntimeRecord
  error: string
  recipeResult?: EphemeralVmRecipeResult
}): EphemeralVmResumeIntegrityFailure {
  const provisionedProjectRoot = ownsProvisionedRoot(args.existing)
    ? (args.existing.provisionedProjectRoot ??
      getEphemeralVmRecipeResultProjectRoot(args.existing.recipeResult))
    : undefined
  const runtime = updateEphemeralVmRuntimeStatus(args.userDataPath, args.existing.id, {
    status: 'resume_failed',
    ...(args.recipeResult ? { recipeResult: args.recipeResult } : {}),
    ...(provisionedProjectRoot ? { provisionedProjectRoot } : {}),
    updatedAt: Date.now()
  })
  return { ok: false, runtime, error: args.error }
}

function failResumeIntegrity(
  userDataPath: string,
  existing: EphemeralVmRuntimeRecord,
  resume: EphemeralVmRecipeStartSuccess,
  error: string,
  provisionedProjectRoot?: string
): EphemeralVmResumeIntegrityResult {
  const runtime = updateEphemeralVmRuntimeStatus(userDataPath, existing.id, {
    status: 'resume_failed',
    recipeResult: resume.result,
    ...(provisionedProjectRoot ? { provisionedProjectRoot } : {}),
    updatedAt: Date.now()
  })
  return { ok: false, runtime, error }
}
