/** A cloud dictation in flight: a batch upload buffers audio until finish, a real-time stream sends it as it comes. */
export type CloudDictationSession = {
  /** Returns true on the chunk that reaches the per-dictation audio cap. */
  feedAudio(samples: Float32Array, sampleRate: number): boolean
  /** Resolves with the text not yet sent as a 'final' event. */
  finish(): Promise<string>
  /** Drops the dictation without waiting for the provider. */
  cancel(): void
}
