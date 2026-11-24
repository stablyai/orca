// Each sign-in attempt takes a number; sign-out and a newer link supersede older attempts.
let nextAttempt = 0
let linkedAttempt = 0

export function beginCloudConnectAttempt(): number {
  return ++nextAttempt
}

export function isNewestCloudConnectAttempt(attempt: number): boolean {
  return attempt === nextAttempt
}

export function isCloudConnectAttemptSuperseded(attempt: number): boolean {
  return attempt < linkedAttempt
}

export function markCloudConnectAttemptLinked(attempt: number): void {
  linkedAttempt = attempt
}

/** Supersedes every outstanding attempt; returns the epoch a later link moves past. */
export function supersedeCloudConnectAttempts(): number {
  nextAttempt += 1
  linkedAttempt = nextAttempt
  return linkedAttempt
}

export function cloudConnectLinkEpoch(): number {
  return linkedAttempt
}
