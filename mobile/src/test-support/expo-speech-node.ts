// Why: silent Node stand-in for expo-speech, so tests reaching the speaker skip the native module.
type SpeechOptions = { onDone?: () => void }

export function speak(_text: string, options?: SpeechOptions): void {
  options?.onDone?.()
}

export async function stop(): Promise<void> {}
