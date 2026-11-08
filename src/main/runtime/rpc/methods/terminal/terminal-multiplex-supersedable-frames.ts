import {
  TerminalStreamOpcode,
  decodeTerminalStreamText
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createBellDetector } from '../../../../../shared/terminal/output/terminal-bell-detector'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'

// Alternate-screen enter/exit (?1049, ?1047, ?47 alone or in a list), OSC clipboard/notification writes and 8-bit
// OSC are what a screen-only snapshot cannot replay; a loose match only forgoes superseding.
const UNSUPERSEDABLE_MARKERS = [
  '1049',
  '1047',
  '?47',
  ';47',
  '\x1b]52;',
  '\x1b]9;',
  '\x1b]777;',
  '\x1b]99;',
  '\x9d'
]
// A marker split at the send boundary leaves at most this many characters in the sent frame.
const SENT_TAIL_CHARS = Math.max(...UNSUPERSEDABLE_MARKERS.map((marker) => marker.length)) - 1

// Opt-in: every recovery snapshot still makes current clients replay their reattach reset (cursor shape and
// visibility, focus reporting), which is visible when it fires routinely; enable once clients can skip it.
export function isAltBacklogSupersedeEnabled(): boolean {
  return process.env.ORCA_TERMINAL_SUPERSEDE_ALT_BACKLOG === '1'
}

/** End of the text the client has already been sent; null when it was a span whose raw text is unknown. */
export function supersedableSentTail(
  previousTail: string | null,
  chunk: TerminalOutputFrameChunk
): string | null {
  if (chunk.opcode === TerminalStreamOpcode.OutputSpan) {
    return null
  }
  const text = decodeTerminalStreamText(
    chunk.bytes.subarray(Math.max(0, chunk.bytes.byteLength - 4 * SENT_TAIL_CHARS))
  )
  if (text.length < SENT_TAIL_CHARS && previousTail === null) {
    return null
  }
  return ((text.length < SENT_TAIL_CHARS ? previousTail : '') + text).slice(-SENT_TAIL_CHARS)
}

/** True when a screen-only alt snapshot fully replaces these frames: plain text that never switches screen, rings a
 * bell, or carries an OSC side effect, including markers split across frames or the send boundary. */
export function framesAreSupersedable(
  sentTail: string | null,
  chunks: readonly TerminalOutputFrameChunk[]
): boolean {
  if (
    sentTail === null ||
    chunks.some((chunk) => chunk.opcode === TerminalStreamOpcode.OutputSpan)
  ) {
    return false
  }
  const queued = chunks.map((chunk) => decodeTerminalStreamText(chunk.bytes)).join('')
  const text = sentTail + queued
  // A fresh detector treats a BEL that ends an OSC begun in sent output as a bell, which only forgoes superseding.
  return (
    !UNSUPERSEDABLE_MARKERS.some((marker) => text.includes(marker)) &&
    !createBellDetector().chunkContainsBell(queued)
  )
}
