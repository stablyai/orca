/**
 * Why: Orca ships more than one cloud transcriber (OpenAI, ElevenLabs) and the dictation
 * session only needs to feed audio and collect the final transcript. One structural contract
 * here keeps the session state, the provider factory, and every client aligned without a
 * class hierarchy or provider-specific branches in the session lifecycle.
 */
export type CloudTranscriptionSession = {
  feedAudio(samples: Float32Array, sampleRate: number): void
  finish(): Promise<string>
}
