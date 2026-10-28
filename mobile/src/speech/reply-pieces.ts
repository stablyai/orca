import { languageSegments } from './language-segments'
import type { Piece } from './reader-model'
import { splitForSpeech, toSpeechText } from './speech-text'

// Why: the engine can drop an utterance midway; short pieces lose only that piece, retried once.
export const SPEECH_PIECE_LENGTH = 300

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
