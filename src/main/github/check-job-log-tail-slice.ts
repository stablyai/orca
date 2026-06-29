export const PR_CHECK_LOG_TAIL_LINES = 200
export const PR_CHECK_LOG_TAIL_RECENT_LINES = 100
export const PR_CHECK_LOG_TAIL_BYTES = 16 * 1024
export const PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES = 2
export const PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES = 30
export const PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR = '… earlier errors …'

// Why: install/cache steps can flood the tail; pull a small window around earlier
// error markers so failures remain visible without downloading the full job log.
const ERROR_LINE_PATTERN =
  /(?:##\[error\]|::error::|::error\b|\berror:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)/i

function applyLogTailByteCap(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= PR_CHECK_LOG_TAIL_BYTES) {
    return text
  }
  return sliceTrailingTextByUtf8Bytes(text, PR_CHECK_LOG_TAIL_BYTES)
}

function sliceTrailingTextByUtf8Bytes(text: string, byteLimit: number): string {
  let byteLength = 0
  const characters = Array.from(text)
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const characterByteLength = Buffer.byteLength(characters[index] ?? '', 'utf8')
    if (byteLength + characterByteLength > byteLimit) {
      return characters.slice(index + 1).join('')
    }
    byteLength += characterByteLength
  }
  return text
}

function joinLogExcerptWithByteCap(prefixLines: string[], recentLines: string[]): string {
  const prefix = prefixLines.join('\n')
  const prefixByteLength = Buffer.byteLength(prefix, 'utf8')
  if (prefixByteLength >= PR_CHECK_LOG_TAIL_BYTES) {
    return sliceTrailingTextByUtf8Bytes(prefix, PR_CHECK_LOG_TAIL_BYTES)
  }

  const separator = prefix.length > 0 && recentLines.length > 0 ? '\n' : ''
  const recentBudget =
    PR_CHECK_LOG_TAIL_BYTES - prefixByteLength - Buffer.byteLength(separator, 'utf8')
  const recentTail = sliceTrailingTextByUtf8Bytes(recentLines.join('\n'), recentBudget)
  return `${prefix}${separator}${recentTail}`
}

function collectEarlierErrorLineIndexes(lines: string[], recentStart: number): number[] {
  const indexes = new Set<number>()
  for (let index = 0; index < recentStart; index += 1) {
    if (!ERROR_LINE_PATTERN.test(lines[index] ?? '')) {
      continue
    }
    const contextStart = Math.max(0, index - PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES)
    const contextEnd = Math.min(recentStart - 1, index + PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES)
    for (let contextIndex = contextStart; contextIndex <= contextEnd; contextIndex += 1) {
      indexes.add(contextIndex)
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

export function sliceCheckLogTail(logText: string): string {
  const lines = logText.split(/\r?\n/)
  const recentStart = Math.max(0, lines.length - PR_CHECK_LOG_TAIL_RECENT_LINES)
  const recentLines = lines.slice(recentStart)

  if (recentStart === 0) {
    return applyLogTailByteCap(lines.join('\n'))
  }

  const earlierIndexes = collectEarlierErrorLineIndexes(lines, recentStart)
  if (earlierIndexes.length === 0) {
    return applyLogTailByteCap(lines.slice(-PR_CHECK_LOG_TAIL_LINES).join('\n'))
  }

  const cappedEarlierIndexes = earlierIndexes.slice(-PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES)
  const earlierLines = cappedEarlierIndexes.map((index) => lines[index] ?? '')
  // Why: if the recent tail alone exceeds the byte cap, keep the earlier error
  // context visible instead of truncating it back out of the combined excerpt.
  return joinLogExcerptWithByteCap(
    [...earlierLines, PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR],
    recentLines
  )
}
