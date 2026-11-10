/** Saved facts a resume decision reads by name, without opening or restoring the chat's journal. */
export type AcpSavedSessionReads = {
  /** Whether any saved turn belongs to the provider session with this native id. */
  hasProviderTurn(sessionId: string, nativeId: string): Promise<boolean>
}

/** Unreadable journals cannot prove no exchange. */
export async function nothingExchangedOn(
  reads: AcpSavedSessionReads,
  sessionId: string,
  nativeId: string
): Promise<boolean> {
  try {
    return !(await reads.hasProviderTurn(sessionId, nativeId))
  } catch {
    return false
  }
}
