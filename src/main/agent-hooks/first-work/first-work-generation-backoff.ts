// Usage-limit failures spawned hundreds of sessions on repeated working events (#9705); back off until recovery.
export const FIRST_WORK_GENERATION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 1_800_000]

type GenerationFailures = { incarnation: string; count: number; retryAt: number }

const failuresByWorkspace = new Map<string, GenerationFailures>()

export function resetFirstWorkGenerationBackoff(): void {
  failuresByWorkspace.clear()
}

/** A recreated workspace at the same id starts fresh; the old incarnation's failures do not gate it. */
export function isFirstWorkGenerationBackingOff(
  workspaceId: string,
  incarnation: string,
  now = Date.now()
): boolean {
  const failures = failuresByWorkspace.get(workspaceId)
  if (!failures) {
    return false
  }
  if (failures.incarnation !== incarnation) {
    failuresByWorkspace.delete(workspaceId)
    return false
  }
  return now < failures.retryAt
}

export function recordFirstWorkGenerationFailure(
  workspaceId: string,
  incarnation: string,
  now = Date.now()
): void {
  const previous = failuresByWorkspace.get(workspaceId)
  const count = (previous?.incarnation === incarnation ? previous.count : 0) + 1
  const delays = FIRST_WORK_GENERATION_RETRY_DELAYS_MS
  const delay = delays[Math.min(count, delays.length) - 1] ?? 0
  failuresByWorkspace.set(workspaceId, { incarnation, count, retryAt: now + delay })
}

export function clearFirstWorkGenerationFailures(workspaceId: string): void {
  failuresByWorkspace.delete(workspaceId)
}
