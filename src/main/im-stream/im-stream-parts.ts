// A long answer cut into the messages a platform takes: within its limit (UTF-8 bytes or UTF-16
// code units), labelled, never a character dropped, and a code block cut between parts closed at
// the cut and reopened in the next part, so each renders.
import {
  clampUtf8TextPrefix,
  getUtf8ByteLength,
  getUtf8ChunkEndIndex
} from '../../shared/text/utf8-byte-limits'
import { sliceAtCodeUnitLimit } from '../../shared/text/surrogate-safe-text-slice'

/** A platform's message limit, in the unit it counts. */
export type ImTextLimit = { maxBytes: number } | { maxChars: number }

/** Words around one part of an answer split across messages; part and total count from 1. */
export type ImPartLabel = (part: number, total: number) => { before: string; after: string }

export const IM_PART_LABEL: ImPartLabel = (part, total) => ({
  before: part > 1 ? `(${part}/${total})\n` : '',
  after: part < total ? `\n\n(${part}/${total}, continued)` : ''
})

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const FENCE_CHARS = 60
// A cut prefers the last of these in the part's back half, in this order.
const BOUNDARIES = ['\n\n', '\n', '。', '. ', ' ']

type Measure = {
  size: (text: string) => number
  /** The end of the longest prefix within `budget`, never inside a character. */
  end: (text: string, budget: number) => number
  clamp: (text: string, budget: number) => string
}

function measureOf(limit: ImTextLimit): { max: number; measure: Measure } {
  if ('maxBytes' in limit) {
    return {
      max: limit.maxBytes,
      measure: {
        size: getUtf8ByteLength,
        end: (text, budget) => getUtf8ChunkEndIndex(text, 0, budget),
        clamp: clampUtf8TextPrefix
      }
    }
  }
  const clamp = (text: string, budget: number) => sliceAtCodeUnitLimit(text, budget)
  return {
    max: limit.maxChars,
    measure: {
      size: (text) => text.length,
      end: (text, budget) => clamp(text, budget).length,
      clamp
    }
  }
}

function cutAt(text: string, budget: number, measure: Measure): number {
  const end = measure.end(text, budget)
  if (end >= text.length) {
    return text.length
  }
  const floor = Math.floor(end / 2)
  for (const boundary of BOUNDARIES) {
    const at = text.lastIndexOf(boundary, end - boundary.length)
    if (at > floor) {
      return at + boundary.length
    }
  }
  return end
}

/** The text in pieces within the limit, whose concatenation is exactly the text. */
export function splitImPieces(text: string, limit: ImTextLimit): string[] {
  const { max, measure } = measureOf(limit)
  // Room for any one character: four bytes, or a surrogate pair.
  if (max < ('maxBytes' in limit ? 4 : 2)) {
    throw new Error('IM message limit too small for one character')
  }
  const pieces: string[] = []
  let rest = text
  while (measure.size(rest) > max) {
    const end = cutAt(rest, max, measure)
    pieces.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest.length > 0 || pieces.length === 0) {
    pieces.push(rest)
  }
  return pieces
}

/** The fence a part leaves open, carried in from `open`: its opening line, or null. A closing fence
 *  uses the opening's character, at least as many, and no info string (CommonMark). */
function openFenceAfter(text: string, open: string | null): string | null {
  let fence = open
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) {
      continue
    }
    if (fence === null) {
      fence = line.trim()
    } else if (!match[2]!.trim() && match[1]!.startsWith(FENCE.exec(fence)![1]!)) {
      fence = null
    }
  }
  return fence
}

/** An answer as the messages that carry it, each within the limit with its label. */
export function splitImText(
  text: string,
  limit: ImTextLimit,
  label: ImPartLabel = IM_PART_LABEL
): string[] {
  const { max, measure } = measureOf(limit)
  if (measure.size(text) <= max) {
    return [text]
  }
  const sample = label(999, 999)
  // Room for the label and a fence closed and reopened, each clamped to FENCE_CHARS.
  const budget = max - measure.size(sample.before + sample.after) - 2 * (FENCE_CHARS + 2)
  if (budget < 64) {
    throw new Error('IM message limit too small to split into')
  }
  const pieces = splitImPieces(
    text,
    'maxBytes' in limit ? { maxBytes: budget } : { maxChars: budget }
  )
  let open: string | null = null
  return pieces.map((piece, index) => {
    const reopened = open === null ? '' : `${measure.clamp(open, FENCE_CHARS)}\n`
    open = openFenceAfter(piece, open)
    const marker = open === null ? '' : measure.clamp(FENCE.exec(open)![1]!, FENCE_CHARS)
    const closed =
      !marker || index === pieces.length - 1 ? '' : `${piece.endsWith('\n') ? '' : '\n'}${marker}`
    const { before, after } = label(index + 1, pieces.length)
    return `${before}${reopened}${piece}${closed}${after}`
  })
}
