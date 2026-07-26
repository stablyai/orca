import { Buffer } from 'node:buffer'

export const PROCESS_LINE_MAX_BYTES = 64 * 1024
export const PROCESS_OUTPUT_TAIL_MAX_CODE_UNITS = 64 * 1024
const TRUNCATED_LINE_SUFFIX = '… [line truncated]'

export function appendProcessOutputTail(
  current,
  line,
  maxCodeUnits = PROCESS_OUTPUT_TAIL_MAX_CODE_UNITS
) {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
    throw new RangeError('Process output tail limit must be a non-negative safe integer')
  }
  if (maxCodeUnits === 0) {
    return ''
  }
  const appended = `${current}${line}\n`
  return appended.length <= maxCodeUnits ? appended : appended.slice(-maxCodeUnits)
}

export function attachBoundedProcessLineReader(
  stream,
  onLine,
  maxLineBytes = PROCESS_LINE_MAX_BYTES
) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0) {
    throw new RangeError('Process line limit must be a non-negative safe integer')
  }

  const retained = Buffer.allocUnsafe(maxLineBytes)
  let retainedBytes = 0
  let truncated = false
  let swallowLineFeed = false
  let closed = false

  const append = (bytes, start, end) => {
    if (start >= end) {
      return
    }
    const available = maxLineBytes - retainedBytes
    const copied = Math.min(available, end - start)
    if (copied > 0) {
      bytes.copy(retained, retainedBytes, start, start + copied)
      retainedBytes += copied
    }
    truncated ||= copied < end - start
  }

  const emit = () => {
    const line = retained.subarray(0, retainedBytes).toString('utf8')
    onLine(truncated ? `${line}${TRUNCATED_LINE_SUFFIX}` : line)
    retainedBytes = 0
    truncated = false
  }

  const onData = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    if (swallowLineFeed) {
      swallowLineFeed = false
      if (bytes[0] === 0x0a) {
        start = 1
      }
    }

    for (let index = start; index < bytes.length; index += 1) {
      const value = bytes[index]
      if (value !== 0x0a && value !== 0x0d) {
        continue
      }
      append(bytes, start, index)
      emit()
      if (value === 0x0d && index + 1 < bytes.length && bytes[index + 1] === 0x0a) {
        index += 1
      } else if (value === 0x0d && index + 1 === bytes.length) {
        swallowLineFeed = true
      }
      start = index + 1
    }
    append(bytes, start, bytes.length)
  }

  const detach = () => {
    if (closed) {
      return
    }
    closed = true
    stream.off('data', onData)
    stream.off('end', onEnd)
  }

  const onEnd = () => {
    if (retainedBytes > 0 || truncated) {
      emit()
    }
    detach()
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  return detach
}
