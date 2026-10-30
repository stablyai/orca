import type { Piece } from './reader-model'
import { logSpeechEvent } from './speech-diagnostics'
import { playChime, speakUtterance, type UtteranceCallbacks } from './tts-engine'

const RETRIES_PER_PIECE = 1
// The settings sample playing beside the reader; it gives way as soon as the reader plays.
let aside: object | null = null

/**
 * One piece of a message (`index` of `count`), spoken from character `from`. `owns` says whether
 * the reader still wants it; `onEnd` runs once it is done, or failed twice.
 */
export type PieceRun = {
  piece: Piece
  index: number
  count: number
  from: number
  owns: () => boolean
  onEnd: () => void
}

/** Plays a piece of the reader's, and tries it once more when the engine drops it. */
export function playPieceRun(run: PieceRun): void {
  aside = null
  playAttempt(run, 0)
}

/** Plays a settings sample outside the reader, whose queue and history it leaves alone. */
export function playAside(pieces: readonly Piece[]): void {
  const sample = {}
  aside = sample
  playFrom(pieces, 0, () => aside === sample)
}

function playFrom(pieces: readonly Piece[], index: number, owns: () => boolean): void {
  const piece = pieces[index]
  if (piece === undefined) {
    return
  }
  const onEnd = () => playFrom(pieces, index + 1, owns)
  playAttempt({ piece, index, count: pieces.length, from: 0, owns, onEnd }, 0)
}

function playAttempt(run: PieceRun, attempt: number): void {
  const { piece, index, count, from, owns, onEnd } = run
  const position = `${index + 1}/${count}`
  const handlers: UtteranceCallbacks = {
    onStart: () => {
      if (index === 0 || attempt > 0) {
        logSpeechEvent(`speaking ${position}${attempt > 0 ? ' (retry)' : ''}`)
      }
    },
    onDone: () => {
      if (owns()) {
        onEnd()
      }
    },
    onError: (error) => {
      const message = error?.message ?? 'unknown error'
      logSpeechEvent(`piece ${position} failed: ${message}`)
      if (!owns()) {
        return
      }
      if (attempt < RETRIES_PER_PIECE) {
        playAttempt(run, attempt + 1)
      } else {
        onEnd()
      }
    }
  }
  if (piece.kind === 'chime') {
    playChime(handlers)
  } else {
    speakUtterance(piece.text.slice(from), handlers, piece.language ?? null)
  }
}
