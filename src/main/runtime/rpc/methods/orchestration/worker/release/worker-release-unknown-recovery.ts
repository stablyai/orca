export function releaseUnknownRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then retry worker-release with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays this release_unknown receipt. Never substitute a broad terminal close.`
}
