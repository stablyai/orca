import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type {
  EphemeralVmRecipeStartFailure,
  EphemeralVmRecipeStartSuccess
} from './ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../shared/types'

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
  | { ok: true; start: EphemeralVmRecipeStartSuccess; runtime: EphemeralVmRuntimeRecord }
  | { ok: false; start: EphemeralVmRecipeStartFailure }

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
  | { ok: true; runtime: EphemeralVmRuntimeRecord; skipped: boolean }
  | { ok: false; runtime: EphemeralVmRuntimeRecord; error: string }

export type SuspendEphemeralVmRuntimeResult = CleanupEphemeralVmRuntimeResult
export type ResumeEphemeralVmRuntimeResult = CleanupEphemeralVmRuntimeResult
