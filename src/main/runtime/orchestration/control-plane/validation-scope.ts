/** B9 (correction 2) — the scope a validation lease actually protects.
 *
 *  The thing a running suite can be contaminated by is a mutation of the
 *  WORKTREE, so the worktree id is the scope whenever the runtime can resolve
 *  one. A Run with no resolvable worktree (a folder workspace whose terminal is
 *  gone, a federated attachment) falls back to the Run id, which is coarser but
 *  never wrong: it protects a superset.
 */
export function validationScopeKeyForWorktree(worktreeId: string): string {
  return `wt:${worktreeId}`
}

export function validationScopeKeyForRun(runId: string): string {
  return `run:${runId}`
}

export type ValidationScopeResolver = {
  showTerminal(handle: string): Promise<{ worktreeId: string }>
}

export async function resolveValidationScopeKey(args: {
  runtime: ValidationScopeResolver
  terminalHandle?: string
  runId: string
}): Promise<string> {
  if (!args.terminalHandle) {
    return validationScopeKeyForRun(args.runId)
  }
  try {
    const terminal = await args.runtime.showTerminal(args.terminalHandle)
    return terminal.worktreeId
      ? validationScopeKeyForWorktree(terminal.worktreeId)
      : validationScopeKeyForRun(args.runId)
  } catch {
    // Why the fallback rather than a throw: refusing to name a scope would turn
    // a missing terminal into an unguardable mutation.
    return validationScopeKeyForRun(args.runId)
  }
}
