export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export type CloudTranscriptionSession = {
  start(): Promise<void>
  feedAudio(samples: Float32Array, sampleRate: number): void
  finish(): Promise<string>
}
