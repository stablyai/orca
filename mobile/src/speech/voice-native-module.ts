export type NativeVoice = {
  name: string
  /** BCP 47, e.g. `pl-PL`. */
  language: string
  needsInternet: boolean
  installed: boolean
}

export type NativeVoiceList = {
  voices: NativeVoice[]
  defaultVoice: string | null
  /** What the engine reads in when no voice is chosen. */
  language: string
}

/** `rate` 1 = normal; null rate or voice = the phone's text-to-speech setting. */
export type SpeechOptions = { rate: number | null; voice: string | null }

export type ReaderState = 'idle' | 'reading' | 'paused'

/** Mirrors `ReadAloudControls` in the native module. */
export type ReaderControl = 'stop' | 'previous' | 'pause' | 'play' | 'next'

export type VoiceNativeModule = {
  start(tickMs: number): boolean
  stop(): boolean
  isRunning(): boolean
  /** `language`: primary subtag of a voice to read this in; null for the reading voice. */
  speak(id: string, text: string, language: string | null): boolean
  /** Android 10+ guesses, null where it has none; synchronous, so call it once per message. */
  detectLanguages(texts: string[]): ({ language: string; confidence: number } | null)[]
  /** One utterance, with the speech's audio attributes and focus. */
  chime(id: string): boolean
  stopSpeech(): void
  /** Where the word being read in utterance `id` starts; 0 when the engine reports no words. */
  spokenOffset(id: string): number
  /**
   * `phoneRate`: the rate the phone's text-to-speech settings give, 1 = normal. `language`: BCP 47
   * tag of the voice the reader last read with, null before its engine first started.
   */
  getSpeechOptions(): (SpeechOptions & { phoneRate: number; language: string | null }) | null
  setSpeechOptions(rate: number | null, voice: string | null): boolean
  /** Null when the engine did not start. */
  getVoices(): Promise<NativeVoiceList | null>
  openTtsSettings(): boolean
  /** What the notification's title and auto-read button show. */
  setAutoReadPaused(paused: boolean): void
  /**
   * Picks the notification's buttons and text (`status`) and holds the headset and steering-wheel
   * buttons while not idle; `title` is what a car's display shows.
   */
  setReaderState(
    state: ReaderState,
    title: string | null,
    status: string | null,
    canRepeat: boolean,
    canPrevious: boolean,
    canNext: boolean
  ): void
  /** Whether sound goes to headphones, a car or the like rather than the phone's own speaker. */
  isPrivateOutput(): boolean
  addListener(event: 'onTick' | 'onAutoReadToggle', listener: () => void): { remove(): void }
  addListener(
    event: 'onReaderControl',
    listener: (payload: { action: ReaderControl }) => void
  ): { remove(): void }
  addListener(
    event: 'onSpeech',
    listener: (payload: { event: string; id: string; message: string | null }) => void
  ): { remove(): void }
}

let nativeModule: VoiceNativeModule | null | undefined

/** `modules/orca-read-aloud` on Android; null elsewhere, in tests, and in builds without it. */
export function voiceNativeModule(): VoiceNativeModule | null {
  if (nativeModule === undefined) {
    nativeModule = null
    try {
      // Why: lazy, so test suites that import this never load React Native's Flow sources.
      // oxlint-disable-next-line typescript/no-require-imports
      const { Platform }: typeof import('react-native') = require('react-native')
      if (Platform.OS === 'android') {
        // oxlint-disable-next-line typescript/no-require-imports
        const core: typeof import('expo-modules-core') = require('expo-modules-core')
        nativeModule = core.requireOptionalNativeModule<VoiceNativeModule>('OrcaReadAloud')
      }
    } catch {
      nativeModule = null
    }
  }
  return nativeModule
}
