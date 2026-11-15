/** The phone's voice as a reply's Read aloud button uses it. */
export type ReadAloudEngine = {
  available: boolean
  /** Resolves when the voice finishes, is stopped, or fails. */
  speak: (text: string) => Promise<void>
  stop: () => void
}
