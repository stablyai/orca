/** Native sessions have no page Back claim; the header's leave path is the back. */
export function useSessionRailBack(nativeBack: () => void): () => void {
  return nativeBack
}
