import { stripAnsiEscapeSequences } from '../../shared/terminal/protocol/escape/ansi-escape-sequences'

// Spinners send the cursor back to the line start with a large count (e.g. ESC[999D); a short move
// only nudges within the line, so it stays text-preserving.
// oxlint-disable-next-line no-control-regex -- ESC is the sequence being matched.
const BACK_TO_LINE_START = /\u001b\[\d{3,}D/g

/**
 * An updater's output as a person reads it after the fact: plain text, and a spinner or progress
 * line that redraws itself (carriage return, or the cursor sent back to the line start) keeps only
 * its last frame.
 */
export function plainUpdaterOutput(text: string): string {
  return text
    .replace(BACK_TO_LINE_START, '\r')
    .split('\n')
    .map((line) => {
      const frames = stripAnsiEscapeSequences(line).split('\r')
      return frames.findLast((frame) => frame.trim() !== '') ?? ''
    })
    .join('\n')
    .trim()
}
