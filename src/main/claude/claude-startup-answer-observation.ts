import { StringDecoder } from 'node:string_decoder'
import { createIncrementalNdjsonFramer } from '../../shared/main-process-ndjson-framer'

// Unescaped quotes occur only as JSON structure, so other records skip this second parse.
const FAILED_RESULT_TOKENS = [/"type"\s*:\s*"result"/, /"is_error"\s*:\s*true/]

function mayBeFailedResult(text: string): boolean {
  return FAILED_RESULT_TOKENS.every((token) => token.test(text))
}

/** Observe before SDK cleanup can wait on transcript flushing; feed is the connection's one stdout tap. */
export function claudeStartupAnswerObservation(next?: (chunk: Buffer | string) => void) {
  let failure: Error | undefined
  let done = false
  const decoder = new StringDecoder('utf8')
  const stop = (): void => {
    done = true
    framer.reset()
  }
  const observe = (record: unknown): void => {
    if (
      typeof record === 'object' &&
      record !== null &&
      'type' in record &&
      record.type === 'result' &&
      'is_error' in record &&
      record.is_error === true &&
      !('parent_tool_use_id' in record && record.parent_tool_use_id)
    ) {
      failure ??= Object.assign(new Error('claude reported a failed result during startup'), {
        errorClass: 'error_result'
      })
      stop()
    }
  }
  // The shared line budget bounds retention; a rejected prefix cannot prove a root record.
  // A capture ends parsing mid-chunk; the rest of that chunk only reaches the next handler.
  const framer = createIncrementalNdjsonFramer(observe, () => {}, {
    acceptLine: (line) => !done && mayBeFailedResult(line)
  })
  return {
    failure: () => failure,
    finish: stop,
    // Observes until capture, send or close; every chunk still reaches the next handler.
    feed: (chunk: Buffer | string): void => {
      if (!done) {
        framer.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk))
        if (done) {
          framer.reset()
        }
      }
      next?.(chunk)
    }
  }
}
