import { isTerminalWaitWhitespace } from '../terminal/wait/terminal-wait-tail-window'
import {
  lastSupportedIndex,
  supportedRegexMatches
} from '../../../shared/terminal/output/terminal-supported-occurrences'
import {
  offsetTerminalSupport,
  type TerminalSupportQuery
} from '../../../shared/terminal/output/terminal-content-origin'

/** agy 1.2.7 adds edit mode to the caret row; accept it without admitting >-prefixed menu choices. */
function isComposerLine(value: string): boolean {
  return value === '>' || /^>\s+[a-z][a-z-]*\s+mode:\s/i.test(value)
}

function isModelRow(line: string): boolean {
  const trimmed = line.trim()
  if (
    !trimmed ||
    trimmed === '>' ||
    trimmed.includes('antigravity cli') ||
    /^resume with -c|^agy --conversation=/i.test(trimmed)
  ) {
    return false
  }
  if (
    trimmed.includes('@') ||
    trimmed.includes('antigravity business') ||
    trimmed.includes('for shortcuts') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('/') ||
    /^[a-z]:\\/i.test(trimmed)
  ) {
    return false
  }
  return true
}

/** Cursor-addressed chrome makes row anchors unstable, requiring a whole-tail composer scan. */
export function findAntigravityComposerIndex(
  normalized: string,
  support?: TerminalSupportQuery
): number | null {
  const contentStart = lastSupportedIndex(normalized, 'antigravity cli', support)
  if (contentStart === -1) {
    return null
  }

  let offset = 0
  let composerStart: number | null = null
  let workspaceBeforeComposer = false
  let workspaceAfterComposer = false
  let modelAfterComposer = false
  while (offset <= normalized.length) {
    const lineStart = offset
    const newlineIndex = normalized.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 ? normalized.length : newlineIndex
    let trimmedStart = lineStart
    let trimmedEnd = lineEnd
    while (trimmedStart < trimmedEnd && isTerminalWaitWhitespace(normalized, trimmedStart)) {
      trimmedStart += 1
    }
    while (trimmedEnd > trimmedStart && isTerminalWaitWhitespace(normalized, trimmedEnd - 1)) {
      trimmedEnd -= 1
    }
    const lineValue = normalized.slice(trimmedStart, trimmedEnd)
    const eligible = !support || support(trimmedStart, trimmedEnd)
    if (trimmedStart >= contentStart && isComposerLine(lineValue) && eligible) {
      composerStart = trimmedStart
      modelAfterComposer = false
    } else if (trimmedStart >= contentStart && eligible) {
      const value = lineValue
      const isWorkspace =
        value.startsWith('~/') || value.startsWith('/') || /^[a-z]:\\/i.test(value)
      if (composerStart === null) {
        workspaceBeforeComposer ||= isWorkspace
      } else {
        workspaceAfterComposer ||= isWorkspace
        modelAfterComposer ||= isModelRow(value)
      }
    }
    offset = lineEnd + 1
    if (newlineIndex === -1) {
      break
    }
  }
  if (composerStart === null) {
    return null
  }
  // Menus also retain a caret; only the latest screen can prove readiness.
  if (
    supportedRegexMatches(
      normalized.slice(contentStart),
      /do you trust|sign in|select a model|collect usage|choose a theme|press enter to continue/,
      offsetTerminalSupport(support, contentStart)
    ).length > 0
  ) {
    return null
  }
  if (!workspaceBeforeComposer) {
    return modelAfterComposer ? null : composerStart
  }
  return modelAfterComposer && !workspaceAfterComposer ? null : composerStart
}
