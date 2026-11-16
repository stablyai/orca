/** Saved facts a resume decision reads by name, without opening or restoring the chat's journal. */
export type SavedProviderTurnReads = {
  /** Whether any saved turn belongs to the provider session with this native id, or, with
   *  `sinceFence`, any turn was written at or after that fence. */
  hasProviderTurn(sessionId: string, nativeId: string, sinceFence?: number): Promise<boolean>
}

/** Unreadable journals cannot prove no exchange. */
export async function nothingExchangedOn(
  reads: SavedProviderTurnReads,
  sessionId: string,
  nativeId: string,
  sinceFence?: number
): Promise<boolean> {
  try {
    return !(await reads.hasProviderTurn(sessionId, nativeId, sinceFence))
  } catch {
    return false
  }
}
