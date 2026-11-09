export type SttRecognizerInit = {
  /** The node_modules directory holding transcribe-cpp. */
  speechModulesDir: string
  modelDir: string
  files: string[]
  sampleRate: number
  /** Absent = auto-detect. */
  language?: string
}

export type SttRecognizerEvent =
  /** One decoded offline chunk; `samples` counts the stream's input-rate samples decoded so far. */
  { type: 'chunk'; streamId: string; text: string; samples: number }

export type SttRecognizerPost = (event: SttRecognizerEvent) => void

/** One loaded model in the speech host child, shared by every dictation stream; calls never overlap. */
export type SttRecognizer = {
  /** Starts a stream that expects these spellings; a stream fed without one expects none. */
  open(streamId: string, vocabulary: readonly string[]): void
  feed(streamId: string, samples: Float32Array, sampleRate: number): Promise<void>
  /** Decode the stream's buffered audio, post its text and drop the stream; may throw after posting. */
  finish(streamId: string): Promise<void>
  /** Drop the stream's audio undecoded. */
  discard(streamId: string): void
}
