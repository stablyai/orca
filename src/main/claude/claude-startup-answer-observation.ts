import { StringDecoder } from 'node:string_decoder'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { createIncrementalNdjsonFramer } from '../../shared/main-process-ndjson-framer'

/** Observe before SDK cleanup can wait on transcript flushing. */
export function claudeStartupAnswerObservation() {
  let failure: Error | undefined
  let detach = (): void => {}
  const observe = (record: unknown): void => {
    if (typeof record !== 'object' || record === null) {
      return
    }
    if (
      'type' in record &&
      record.type === 'result' &&
      'is_error' in record &&
      record.is_error === true &&
      !('parent_tool_use_id' in record && record.parent_tool_use_id)
    ) {
      failure ??= Object.assign(new Error('claude reported a failed result during startup'), {
        errorClass: 'error_result'
      })
    }
  }
  return {
    failure: () => failure,
    finish: () => detach(),
    attach: (child: PipedChildProcess): void => {
      const decoder = new StringDecoder('utf8')
      const framer = createIncrementalNdjsonFramer(observe, () => {}, {
        maxLineBytes: Number.POSITIVE_INFINITY
      })
      const onData = (chunk: Buffer | string): void =>
        framer.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk))
      detach = () => {
        child.stdout.removeListener('data', onData)
        framer.reset()
      }
      child.stdout.on('data', onData)
      child.stdout.once('close', () => detach())
    }
  }
}
