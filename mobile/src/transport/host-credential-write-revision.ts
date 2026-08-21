let nextRevision = 1
const revisionByHostId = new Map<string, number>()

export function getHostCredentialWriteRevision(hostId: string): number {
  return revisionByHostId.get(hostId) ?? 0
}

export function markHostCredentialWrite(hostId: string): void {
  revisionByHostId.set(hostId, nextRevision)
  nextRevision += 1
}

export function clearHostCredentialWriteRevision(hostId: string): void {
  revisionByHostId.delete(hostId)
}

/** Test-only: clear session credential generations between cases. */
export function resetHostCredentialWriteRevisionsForTests(): void {
  nextRevision = 1
  revisionByHostId.clear()
}
