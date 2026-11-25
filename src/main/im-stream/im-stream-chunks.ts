import {
  clampUtf8TextPrefix,
  getUtf8ByteLength,
  getUtf8ChunkEndIndex,
  isUtf8ByteLengthWithinLimit
} from '../../shared/text/utf8-byte-limits'

/** Words around one part of an answer split across messages; part and total count from 1. */
export type ImPartLabel = (part: number, total: number) => { before: string; after: string }

export const IM_PART_LABEL: ImPartLabel = (part, total) => ({
  before: part > 1 ? `(${part}/${total})\n` : '',
  after: part < total ? `\n\n(${part}/${total}, continued)` : ''
})

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/

/** The fence a part leaves open, if any: its marker and info string, as written. */
function openFenceAfter(text: string, open: string | null): string | null {
  let fence = open
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) {
      continue
    }
    if (fence === null) {
      fence = `${match[1]}${match[2]}`
    } else if (match[2].trim() === '' && match[1].startsWith(fence[0]!)) {
      fence = null
    }
  }
  return fence
}

function cutAt(text: string, budget: number): number {
  const end = getUtf8ChunkEndIndex(text, 0, budget)
  if (end >= text.length) {
    return text.length
  }
  const floor = Math.floor(end / 2)
  for (const boundary of ['\n\n', '\n', '。', '. ', ' ']) {
    const at = text.lastIndexOf(boundary, end - boundary.length)
    if (at > floor) {
      return at + boundary.length
    }
  }
  return end
}

/** Splits text into parts each within maxBytes (UTF-8), labelled, never dropping any of it. A code
 *  block cut between parts is closed at the cut and reopened in the next part. */
export function splitImText(text: string, maxBytes: number, label = IM_PART_LABEL): string[] {
  if (isUtf8ByteLengthWithinLimit(text, maxBytes)) {
    return [text]
  }
  const sample = label(999, 999)
  const reserve = getUtf8ByteLength(sample.before + sample.after) + 2 * 64
  const budget = maxBytes - reserve
  if (budget < 256) {
    throw new Error('IM message limit too small to split into')
  }
  const bodies: string[] = []
  let rest = text
  let fence: string | null = null
  while (rest.length > 0) {
    const end = cutAt(rest, budget)
    const piece = rest.slice(0, end)
    rest = rest.slice(end)
    const reopened = fence === null ? '' : `${clampUtf8TextPrefix(fence, 60)}\n`
    const after = openFenceAfter(piece, fence)
    const closing = after === null ? '' : `\n${after.match(/^(`{3,}|~{3,})/)![1]!.slice(0, 60)}`
    bodies.push(`${reopened}${piece}${rest.length > 0 ? closing : ''}`)
    fence = after
  }
  return bodies.map((body, index) => {
    const { before, after } = label(index + 1, bodies.length)
    return `${before}${body}${after}`
  })
}
