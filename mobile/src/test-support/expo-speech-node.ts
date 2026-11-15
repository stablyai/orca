// Alias the native-only voice module for Vitest, so chat rows that offer Read aloud need no per-test mock.
export const maxSpeechInputLength = 4000

export function speak(_text: string, options?: { onDone?: () => void }): void {
  options?.onDone?.()
}

export function stop(): Promise<void> {
  return Promise.resolve()
}
