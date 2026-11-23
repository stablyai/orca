import { promisify } from 'node:util'
import { crc32, inflate } from 'node:zlib'

import { isBotAvatarImage } from '../../shared/bot-avatar'

const inflatePng = promisify(inflate)

// Adam7's seven passes, in (start x, start y, step x, step y) order.
type Pass = readonly [number, number, number, number]
const INTERLACED: readonly Pass[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
]
const PLAIN: readonly Pass[] = [[0, 0, 1, 1]]

/** The picker decodes its source before upload. A file from a bot's chat has had no such check. */
export async function isCompleteBotAvatarPng(png: Buffer): Promise<boolean> {
  if (png.length < 33 || !isBotAvatarImage(png)) {
    return false
  }
  const side = png.readUInt32BE(16)
  const depth = png[24]!
  const color = png[25]!
  const interlace = png[28]!
  const channels = [1, 0, 3, 1, 2, 0, 4][color]
  if (
    !channels ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    (depth < 8 && color !== 0 && color !== 3) ||
    (depth === 16 && color === 3) ||
    png[26] !== 0 ||
    png[27] !== 0 ||
    interlace > 1
  ) {
    return false
  }
  const data: Buffer[] = []
  let palette = false
  let dataEnded = false
  for (let start = 8; start + 12 <= png.length;) {
    const size = png.readUInt32BE(start)
    const end = start + 8 + size
    if (end + 4 > png.length || crc32(png.subarray(start + 4, end)) !== png.readUInt32BE(end)) {
      return false
    }
    const kind = png.toString('latin1', start + 4, start + 8)
    if (kind === 'IHDR') {
      if (start !== 8) {
        return false
      }
    } else if (kind === 'PLTE') {
      if (
        palette ||
        data.length ||
        !size ||
        size % 3 ||
        size > 768 ||
        color === 0 ||
        color === 4 ||
        (color === 3 && size / 3 > 2 ** depth)
      ) {
        return false
      }
      palette = true
    } else if (kind === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) {
        return false
      }
      data.push(png.subarray(start + 8, end))
    } else if (kind === 'IEND') {
      return (
        size === 0 &&
        data.length > 0 &&
        validScanlines(data, side, channels * depth, interlace ? INTERLACED : PLAIN)
      )
    } else {
      if ((png[start + 4]! & 32) === 0) {
        return false
      }
      dataEnded = data.length > 0
    }
    start = end + 4
  }
  return false
}

async function validScanlines(
  data: Buffer[],
  side: number,
  bitsPerPixel: number,
  passes: readonly Pass[]
): Promise<boolean> {
  const rows = passes.map(([x, y, dx, dy]) => ({
    count: Math.ceil((side - y) / dy),
    bytes: 1 + Math.ceil((Math.ceil((side - x) / dx) * bitsPerPixel) / 8)
  }))
  const expected = rows.reduce((sum, row) => sum + row.count * row.bytes, 0)
  try {
    const raw = await inflatePng(Buffer.concat(data), { maxOutputLength: expected })
    if (raw.length !== expected) {
      return false
    }
    let offset = 0
    for (const { count, bytes } of rows) {
      for (let i = 0; i < count; i++) {
        if (raw[offset]! > 4) {
          return false
        }
        offset += bytes
      }
    }
    return true
  } catch {
    return false
  }
}
