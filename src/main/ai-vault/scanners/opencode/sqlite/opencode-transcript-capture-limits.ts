import type {
  TranscriptMessage,
  TranscriptMessageSink
} from '../../../transcripts/session-transcript-consumers'

// Captures cross a worker boundary; exceeding either bound must fail, never return a complete-looking prefix.
export const OPENCODE_CAPTURE_RECORD_LIMIT = 20_000
export const OPENCODE_CAPTURE_TEXT_LIMIT = 64 * 1024 * 1024

/** Runs a parse with a sink that keeps every message, failing the whole read past the text budget.
 *  The budget counts decoded text, not stored rows: tool state blobs dwarf what the transcript keeps (#28791). */
export function captureWithTextBudget<T>(
  label: string,
  parse: (sink: TranscriptMessageSink) => T
): { result: T; messages: TranscriptMessage[] } {
  const messages: TranscriptMessage[] = []
  let captured = 0
  const result = parse({
    active: true,
    push: (message) => {
      captured += message.text.length
      if (captured > OPENCODE_CAPTURE_TEXT_LIMIT) {
        throw new Error(`${label} transcript exceeds capture limits; no partial read was published`)
      }
      messages.push(message)
    }
  })
  return { result, messages }
}
