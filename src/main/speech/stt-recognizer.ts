export type SttRecognizerInit = {
  /** The node_modules directory holding transcribe-cpp. */
  speechModulesDir: string
  modelDir: string
  files: string[]
  sampleRate: number
  /** Absent = auto-detect. */
  language?: string
  /** Silero VAD GGUF; when present, offline models show live text at each pause. */
  vadModelPath?: string
}

export type SttRecognizerEvent =
  /** Newly committed text; `samples` counts the stream's input-rate samples it and earlier chunks account for. */
  | { type: 'chunk'; streamId: string; text: string; samples: number }
  /** The uncommitted text so far, which may still change; the next chunk replaces it. */
  | { type: 'partial'; streamId: string; text: string }
  /** Pause-cut streams only: speech was heard whose text hasn't arrived yet. */
  | { type: 'speech-pending'; streamId: string; pending: boolean }
  /** A load step finished, so a slow load is told apart from a hung GPU. */
  | { type: 'loading' }

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
  /** Called on a cancel's arrival, ahead of the queue: skip the stream's remaining chunks; the running decode finishes. */
  cancel(streamId: string): void
}
