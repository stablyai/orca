import type { AgentGenerationFailureOutput } from '../text-generation/agent-failure-output'

// Usage-limit failures spawned hundreds of sessions on repeated working events (#9705); back off until recovery.
export const FIRST_WORK_GENERATION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 1_800_000]

type GenerationFailures = { count: number; retryAt: number }

const failuresByWorkspace = new Map<string, GenerationFailures>()

export function resetFirstWorkGenerationBackoff(): void {
  failuresByWorkspace.clear()
}

export function isFirstWorkGenerationBackingOff(workspaceId: string, now = Date.now()): boolean {
  const failures = failuresByWorkspace.get(workspaceId)
  return failures !== undefined && now < failures.retryAt
}

function recordFirstWorkGenerationFailure(workspaceId: string, now = Date.now()): void {
  const count = (failuresByWorkspace.get(workspaceId)?.count ?? 0) + 1
  const delays = FIRST_WORK_GENERATION_RETRY_DELAYS_MS
  const delay = delays[Math.min(count, delays.length) - 1] ?? 0
  failuresByWorkspace.set(workspaceId, { count, retryAt: now + delay })
}

export function clearFirstWorkGenerationFailures(workspaceId: string): void {
  failuresByWorkspace.delete(workspaceId)
}

export function retryFailedGeneration(
  worktreeId: string,
  generated: { error: string; canceled?: boolean; failureOutput?: AgentGenerationFailureOutput },
  deps: {
    setRenameError: (
      worktreeId: string,
      error: string,
      failureOutput: AgentGenerationFailureOutput | null
    ) => void
  },
  retry: (reason: string) => false
): false {
  if (generated.canceled) {
    return retry(`generation canceled: ${generated.error}`)
  }
  deps.setRenameError(worktreeId, generated.error, generated.failureOutput ?? null)
  recordFirstWorkGenerationFailure(worktreeId)
  return retry(`generation failed: ${generated.error}`)
}
