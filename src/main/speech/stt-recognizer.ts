import type { RecognizerConfigInput } from './stt-worker-model-config'

export type SttRecognizerInit = RecognizerConfigInput & {
  /** The node_modules directory holding this model's engine package. */
  speechModulesDir: string
}

export type SttRecognizerEvent =
  | { type: 'partial'; streamId: string; text: string }
  | { type: 'final'; streamId: string; text: string }
  /** One decoded offline chunk; `samples` counts the stream's input-rate samples decoded so far. */
  | { type: 'chunk'; streamId: string; text: string; samples: number }

export type SttRecognizerPost = (event: SttRecognizerEvent) => void

/** One loaded model in the speech host child, shared by every dictation stream; calls never overlap. */
export type SttRecognizer = {
  feed(streamId: string, samples: Float32Array, sampleRate: number): void | Promise<void>
  /** Decode the stream's buffered audio, post its text and drop the stream; may throw after posting. */
  finish(streamId: string): void | Promise<void>
  /** Drop the stream's audio undecoded. */
  discard(streamId: string): void
}
