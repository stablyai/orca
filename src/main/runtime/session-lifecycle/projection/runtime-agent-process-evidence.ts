/** A prior process's hook cannot describe the shell main started after it. */
export function agentEvidencePredatesProcess(
  processStartedAt: number | null | undefined,
  newestEvidenceAt: number,
  hasCurrentPtyStatus: boolean
): boolean {
  return processStartedAt != null && newestEvidenceAt < processStartedAt && !hasCurrentPtyStatus
}
