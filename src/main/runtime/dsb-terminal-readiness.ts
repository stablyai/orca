import { isTerminalWaitWhitespace } from './terminal-wait-tail-window'

export { isDsbWorkingTitle } from '../../shared/dsb-terminal-title'

const DSB_COMPOSER = '\u276f'

/**
 * Ready when the splash or a finished turn still shows a lone ❯ after the
 * "DeepSeek Build" banner. A shell ❯ has no banner.
 */
export function findDsbReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('deepseek build')
  if (headerIndex === -1) {
    return null
  }
  const composerIndex = findLastLoneComposerIndex(normalized.slice(headerIndex))
  return composerIndex === null ? null : headerIndex + composerIndex
}

function findLastLoneComposerIndex(segment: string): number | null {
  let offset = 0
  let found: number | null = null
  while (offset <= segment.length) {
    const newlineIndex = segment.indexOf('\n', offset)
    const lineEnd = newlineIndex === -1 ? segment.length : newlineIndex
    if (isLoneComposerLine(segment.slice(offset, lineEnd))) {
      found = offset
    }
    if (newlineIndex === -1) {
      break
    }
    offset = newlineIndex + 1
  }
  return found
}

function isLoneComposerLine(line: string): boolean {
  let start = 0
  let end = line.length
  while (start < end && isTerminalWaitWhitespace(line, start)) {
    start += 1
  }
  while (end > start && isTerminalWaitWhitespace(line, end - 1)) {
    end -= 1
  }
  while (start < end && isComposerDecoration(line.charCodeAt(start))) {
    start += 1
    while (start < end && isTerminalWaitWhitespace(line, start)) {
      start += 1
    }
  }
  return end - start === 1 && line.charCodeAt(start) === DSB_COMPOSER.charCodeAt(0)
}

function isComposerDecoration(code: number): boolean {
  return code === 0x2338 || (code >= 0x2500 && code <= 0x257f) || (code >= 0x2580 && code <= 0x259f)
}
