import type { GitAdmissionTier } from './command-runner/git-exec-options'
import {
  createExplicitBareRepositoryReadState,
  type ExplicitBareRepositoryReadState
} from '../../shared/git-bare-repository-command'

export type GitRuntimeOptions = {
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
}

const compareReadStateKey = Symbol('compareReadState')

export type GitCompareOptions = GitRuntimeOptions & {
  [compareReadStateKey]: ExplicitBareRepositoryReadState
}

export function createGitCompareOptions(options: GitRuntimeOptions): GitCompareOptions {
  return { ...options, [compareReadStateKey]: createExplicitBareRepositoryReadState() }
}

export function gitOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
  allowExplicitBareRepositoryRetry?: true
  explicitBareRepositoryReadState?: ExplicitBareRepositoryReadState
} {
  const readState =
    compareReadStateKey in options ? (options as GitCompareOptions)[compareReadStateKey] : undefined
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...(readState
      ? {
          allowExplicitBareRepositoryRetry: true as const,
          explicitBareRepositoryReadState: readState
        }
      : {})
  }
}

/**
 * Options for a git invocation that only reads. Opting in explicitly keeps the
 * shell-free WSL route from depending on `wsl-direct-git-read-commands`
 * classifying the argv, which is a heuristic these call sites already know the
 * answer to.
 */
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
