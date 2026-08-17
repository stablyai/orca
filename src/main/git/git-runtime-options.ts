export type GitRuntimeOptions = {
  wslDistro?: string
  signal?: AbortSignal
}

export function gitOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  }
}

export function gitStatusReadOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  preferWslDirectGit: true
} {
  return { ...gitOptionsForWorktree(cwd, options), preferWslDirectGit: true }
}
