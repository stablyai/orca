import type { Readable } from 'node:stream'

type PluginWorkerOutputSink = (level: 'info' | 'warn' | 'error', line: string) => void

export const PLUGIN_WORKER_OUTPUT_LINE_LIMIT = 8192
const TRUNCATION_SUFFIX = '… [truncated]'

/** Keeps a worker's unterminated output bounded even if it never writes a newline. */
export function pipePluginWorkerOutput(
  stream: Readable | null,
  level: 'info' | 'error',
  log: PluginWorkerOutputSink
): void {
  if (!stream) {
    return
  }
  let buffered = ''
  let discarding = false

  function emit(line: string, truncated = false): void {
    if (line.trim().length > 0) {
      log(
        level,
        truncated
          ? `${line.slice(0, PLUGIN_WORKER_OUTPUT_LINE_LIMIT - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
          : line
      )
    }
  }

  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    let remaining = chunk
    while (remaining.length > 0) {
      if (discarding) {
        const newline = remaining.indexOf('\n')
        if (newline < 0) {
          return
        }
        discarding = false
        remaining = remaining.slice(newline + 1)
        continue
      }
      const newline = remaining.indexOf('\n')
      const segment = newline < 0 ? remaining : remaining.slice(0, newline)
      const available = PLUGIN_WORKER_OUTPUT_LINE_LIMIT - buffered.length
      if (segment.length > available) {
        emit(buffered + segment.slice(0, available), true)
        buffered = ''
        discarding = newline < 0
      } else {
        buffered += segment
        if (newline >= 0) {
          emit(buffered)
          buffered = ''
        }
      }
      if (newline < 0) {
        return
      }
      remaining = remaining.slice(newline + 1)
    }
  })
  stream.on('end', () => {
    if (!discarding) {
      emit(buffered)
    }
    buffered = ''
  })
}
