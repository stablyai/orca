const archivedExitRecoveryByPtyId = new Map<string, string>()

export function beginArchivedSshPtyExitRecovery(ptyId: string, archiveId: string): void {
  archivedExitRecoveryByPtyId.set(ptyId, archiveId)
}

export function takeArchivedSshPtyExitRecovery(ptyId: string): string | undefined {
  const archiveId = archivedExitRecoveryByPtyId.get(ptyId)
  archivedExitRecoveryByPtyId.delete(ptyId)
  return archiveId
}
