import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import {
  buildWindowsIcoFromPng,
  cropImage,
  findOpaqueBounds,
  resizeImage,
  squareWithMargin
} from './trim-windows-icon-source.mjs'

const scriptDir = import.meta.dirname
const projectDir = dirname(dirname(scriptDir))
const buildDir = join(projectDir, 'resources', 'build')

// Why: Windows scales the largest ICO frame down for the taskbar/"Open with"
// list, so the glyph must fill most of that frame to match native apps. The
// macOS safe-area inset left it at ~83%, which is the visible defect (#5357).
const MIN_GLYPH_FILL_FRACTION = 0.92

function largestIcoFrame(icoBuffer) {
  const count = icoBuffer.readUInt16LE(4)
  let best = null
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    let width = icoBuffer.readUInt8(entry)
    if (width === 0) {
      width = 256
    }
    const byteLength = icoBuffer.readUInt32LE(entry + 8)
    const imageOffset = icoBuffer.readUInt32LE(entry + 12)
    if (!best || width > best.width) {
      best = { width, byteLength, imageOffset }
    }
  }
  return best
}

function decodeIcoFrame(icoBuffer, frame) {
  const payload = icoBuffer.subarray(frame.imageOffset, frame.imageOffset + frame.byteLength)
  const isPng =
    payload[0] === 0x89 && payload[1] === 0x50 && payload[2] === 0x4e && payload[3] === 0x47
  if (!isPng) {
    throw new Error('Expected PNG-compressed ICO frame')
  }
  const png = PNG.sync.read(Buffer.from(payload))
  return { width: png.width, height: png.height, data: png.data }
}

function glyphFillFraction(image) {
  const bounds = findOpaqueBounds(image)
  if (!bounds) {
    return 0
  }
  return Math.max(bounds.width, bounds.height) / Math.max(image.width, image.height)
}

describe('Windows ICO glyph fill', () => {
  it('committed resources/build/icon.ico fills the canvas', () => {
    const ico = readFileSync(join(buildDir, 'icon.ico'))
    const frame = decodeIcoFrame(ico, largestIcoFrame(ico))
    expect(glyphFillFraction(frame)).toBeGreaterThanOrEqual(MIN_GLYPH_FILL_FRACTION)
  })

  it('regenerating from the macOS render fills the canvas', () => {
    const sourcePng = readFileSync(join(buildDir, 'icon.png'))
    const ico = buildWindowsIcoFromPng(sourcePng)
    const frame = decodeIcoFrame(ico, largestIcoFrame(ico))
    expect(glyphFillFraction(frame)).toBeGreaterThanOrEqual(MIN_GLYPH_FILL_FRACTION)
  })
})

describe('trim pipeline', () => {
  function solidSquareWithInset(canvas, glyph) {
    const data = Buffer.alloc(canvas * canvas * 4)
    const offset = Math.floor((canvas - glyph) / 2)
    for (let y = 0; y < glyph; y++) {
      for (let x = 0; x < glyph; x++) {
        const idx = ((offset + y) * canvas + (offset + x)) * 4
        data[idx] = 200
        data[idx + 1] = 100
        data[idx + 2] = 50
        data[idx + 3] = 255
      }
    }
    return { width: canvas, height: canvas, data }
  }

  it('finds the opaque glyph bounds and ignores transparent inset', () => {
    const image = solidSquareWithInset(100, 60)
    const bounds = findOpaqueBounds(image)
    expect(bounds).toEqual({ minX: 20, minY: 20, maxX: 79, maxY: 79, width: 60, height: 60 })
  })

  it('crops to the glyph then re-squares with a small margin', () => {
    const image = solidSquareWithInset(100, 60)
    const cropped = cropImage(image, findOpaqueBounds(image))
    expect(cropped.width).toBe(60)
    const squared = squareWithMargin(cropped, 0.04)
    // Glyph (60) plus ~4% margin per side keeps it near-full-bleed.
    expect(glyphFillFraction(squared)).toBeGreaterThanOrEqual(0.9)
    expect(squared.width).toBe(squared.height)
  })

  it('downscales without leaving the glyph undersized', () => {
    const image = solidSquareWithInset(256, 200)
    const filled = squareWithMargin(cropImage(image, findOpaqueBounds(image)))
    const small = resizeImage(filled, 32, 32)
    expect(small.width).toBe(32)
    expect(glyphFillFraction(small)).toBeGreaterThanOrEqual(0.9)
  })
})
