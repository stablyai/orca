import type { IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import {
  LOCALHOST_WORKTREE_COLOR_LIGHTNESS,
  LOCALHOST_WORKTREE_COLOR_SATURATION,
  getLocalhostWorktreeCssColor,
  getLocalhostWorktreeHue
} from '../shared/localhost-worktree-color'

// Why: favicons are the one response the label proxy substitutes. Serving a
// worktree-specific icon at the HTTP layer keeps tabs visually
// distinguishable without rewriting HTML bodies or touching app headers.

const ICON_SIZE = 32
const CIRCLE_RADIUS = 15
const SUPERSAMPLE = 4

export type LocalhostWorktreeFavicon = {
  contentType: string
  body: Buffer
}

export function localhostWorktreeFaviconForRequest(
  label: string,
  request: IncomingMessage
): LocalhostWorktreeFavicon | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null
  }
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  if (pathname === '/favicon.ico') {
    return {
      contentType: 'image/x-icon',
      body: getLocalhostWorktreeFaviconIco(label)
    }
  }
  if (pathname === '/favicon.svg') {
    return {
      contentType: 'image/svg+xml; charset=utf-8',
      body: Buffer.from(getLocalhostWorktreeFaviconSvg(label), 'utf8')
    }
  }
  return null
}

export function getLocalhostWorktreeFaviconSvg(label: string): string {
  const letter = faviconLetter(label)
  const fill = getLocalhostWorktreeCssColor(label)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">` +
    `<circle cx="16" cy="16" r="${CIRCLE_RADIUS}" fill="${fill}"/>` +
    `<text x="16" y="22" font-family="system-ui, sans-serif" font-size="17" font-weight="700" ` +
    `fill="#fff" text-anchor="middle">${letter}</text></svg>`
  )
}

export function getLocalhostWorktreeFaviconIco(label: string): Buffer {
  const [red, green, blue] = hslToRgb(
    getLocalhostWorktreeHue(label),
    LOCALHOST_WORKTREE_COLOR_SATURATION,
    LOCALHOST_WORKTREE_COLOR_LIGHTNESS
  )
  const pixelBytes = ICON_SIZE * ICON_SIZE * 4
  const maskBytes = (ICON_SIZE / 8) * ICON_SIZE
  const bitmapBytes = 40 + pixelBytes + maskBytes
  const buffer = Buffer.alloc(6 + 16 + bitmapBytes)

  buffer.writeUInt16LE(0, 0) // reserved
  buffer.writeUInt16LE(1, 2) // type: icon
  buffer.writeUInt16LE(1, 4) // image count
  buffer.writeUInt8(ICON_SIZE, 6)
  buffer.writeUInt8(ICON_SIZE, 7)
  buffer.writeUInt16LE(1, 10) // color planes
  buffer.writeUInt16LE(32, 12) // bits per pixel
  buffer.writeUInt32LE(bitmapBytes, 14)
  buffer.writeUInt32LE(22, 18) // bitmap offset

  const bitmapStart = 22
  buffer.writeUInt32LE(40, bitmapStart) // BITMAPINFOHEADER size
  buffer.writeInt32LE(ICON_SIZE, bitmapStart + 4)
  // Why: ICO bitmap height counts both the color plane and the AND mask.
  buffer.writeInt32LE(ICON_SIZE * 2, bitmapStart + 8)
  buffer.writeUInt16LE(1, bitmapStart + 12)
  buffer.writeUInt16LE(32, bitmapStart + 14)
  buffer.writeUInt32LE(pixelBytes, bitmapStart + 20)

  const pixelStart = bitmapStart + 40
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const alpha = DISC_ALPHA[y * ICON_SIZE + x] ?? 0
      // Why: ICO pixel rows are stored bottom-up in BGRA order.
      const offset = pixelStart + ((ICON_SIZE - 1 - y) * ICON_SIZE + x) * 4
      buffer.writeUInt8(blue, offset)
      buffer.writeUInt8(green, offset + 1)
      buffer.writeUInt8(red, offset + 2)
      buffer.writeUInt8(alpha, offset + 3)
    }
  }
  // The AND mask stays zeroed: 32-bit icons carry opacity in the alpha channel.
  return buffer
}

function faviconLetter(label: string): string {
  const match = label.match(/[a-z0-9]/i)
  return (match?.[0] ?? '?').toUpperCase()
}

// Why: the disc shape is label-independent, so the alpha grid is computed once
// instead of on every no-store favicon request.
const DISC_ALPHA = buildDiscAlphaGrid()

function buildDiscAlphaGrid(): Uint8Array {
  const grid = new Uint8Array(ICON_SIZE * ICON_SIZE)
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      grid[y * ICON_SIZE + x] = Math.round(circleCoverage(x, y) * 255)
    }
  }
  return grid
}

function circleCoverage(x: number, y: number): number {
  const center = ICON_SIZE / 2
  let covered = 0
  // Why: supersampling gives the disc a smooth edge without an image library.
  for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
    for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
      const sampleX = x + (sx + 0.5) / SUPERSAMPLE - center
      const sampleY = y + (sy + 0.5) / SUPERSAMPLE - center
      if (sampleX * sampleX + sampleY * sampleY <= CIRCLE_RADIUS * CIRCLE_RADIUS) {
        covered += 1
      }
    }
  }
  return covered / (SUPERSAMPLE * SUPERSAMPLE)
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = hue / 60
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1))
  const match = lightness - chroma / 2
  const sextants: [number, number, number][] = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary]
  ]
  const rgb = sextants[Math.min(Math.floor(huePrime), 5)] ?? [chroma, secondary, 0]
  return [
    Math.round((rgb[0] + match) * 255),
    Math.round((rgb[1] + match) * 255),
    Math.round((rgb[2] + match) * 255)
  ]
}
