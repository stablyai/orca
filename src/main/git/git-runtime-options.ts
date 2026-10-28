import type { GitAdmissionTier } from './command-runner/git-exec-options'

export type GitRuntimeOptions = {
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
}

export function gitOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal; admissionTier?: GitAdmissionTier } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

/** Explicit read callers may use shell-free WSL without relying on argv classification. */
export function gitReadOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
  preferWslDirectGit: true
} {
  return { ...gitOptionsForWorktree(cwd, options), preferWslDirectGit: true }
}
