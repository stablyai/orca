import type { Piece } from './reader-model'
import { logSpeechEvent } from './speech-diagnostics'
import { playChime, speakUtterance, type UtteranceCallbacks } from './tts-engine'

const RETRIES_PER_PIECE = 1

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

/** Plays a piece, and tries it once more when the engine drops it. */
export function playPieceRun(run: PieceRun, attempt = 0): void {
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
        playPieceRun(run, attempt + 1)
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
