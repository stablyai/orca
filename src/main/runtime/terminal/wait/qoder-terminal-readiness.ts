import {
  joinedTerminalOrigins,
  lowercaseTerminalSupport,
  terminalSupportQuery,
  type TerminalContentOrigin
} from '../../../../shared/terminal/output/terminal-content-origin'
import { lastSupportedIndex } from '../../../../shared/terminal/output/terminal-supported-occurrences'

// Captured Qoder paints idle while the trust menu still owns input.
export function isQoderComposerReady(
  screenLines: readonly string[] | null,
  scope?: TerminalContentOrigin
): boolean {
  if (!screenLines) {
    return false
  }
  const joined = joinedTerminalOrigins(screenLines)
  const { text, query } = lowercaseTerminalSupport(
    joined.text,
    terminalSupportQuery(joined.origins, scope)
  )
  return (
    lastSupportedIndex(text, 'type your message or @path/to/file', query) !== -1 &&
    lastSupportedIndex(text, "don't trust and exit", query) === -1
  )
}
