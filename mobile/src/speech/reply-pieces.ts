import { languageSegments } from './language-segments'
import type { Piece, Utterance } from './reader-model'
import { splitForSpeech, toSpeechText } from './speech-text'

// Why: the engine can drop an utterance midway; short pieces lose only that piece, retried once.
export const SPEECH_PIECE_LENGTH = 300

export type ReplyIntro = { chime?: boolean; name?: string | null; title?: string | null }

/** A reply as speakable pieces, each run of sentences tagged with its language. */
export function replyPieces(markdown: string): Piece[] {
  return languageSegments(toSpeechText(markdown)).flatMap((segment) =>
    splitForSpeech(segment.text, SPEECH_PIECE_LENGTH).map((text): Piece => ({
      kind: 'text',
      text,
      language: segment.language
    }))
  )
}

/**
 * A reply as the reader queues it, or null when nothing in it is read. The intro is read as pieces
 * of its own so a pause follows the project name.
 */
export function replyUtterance(
  id: string,
  markdown: string,
  auto: boolean,
  intro: ReplyIntro
): Utterance | null {
  const pieces = replyPieces(markdown)
  if (pieces.length === 0) {
    return null
  }
  const body = pieces.map((part) => (part.kind === 'text' ? part.text : '')).join(' ')
  if (intro.name) {
    pieces.unshift({ kind: 'text', text: `${intro.name}.` })
  }
  if (intro.chime) {
    pieces.unshift({ kind: 'chime' })
  }
  return { id, pieces, title: intro.title ?? null, auto, body }
}
