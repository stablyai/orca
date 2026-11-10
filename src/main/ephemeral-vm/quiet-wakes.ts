// Wakes started on intent (before anyone opened the workspace) that must fail without a trace: a
// refusal leaves the VM record as it was instead of saving a failed resume the row would show.
// Opening the workspace while such a wake runs claims it, and its failure is then recorded.
const quiet = new Set<string>()

export function markQuietWake(workspaceId: string): void {
  quiet.add(workspaceId)
}

export function claimQuietWake(workspaceId: string): void {
  quiet.delete(workspaceId)
}

export function isQuietWake(workspaceId: string): boolean {
  return quiet.has(workspaceId)
}
