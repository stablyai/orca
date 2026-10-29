import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  encodeRgbaPng,
  iconFromImageData,
  pickToolbarSize,
  resolveActionIconDataUrl
} from './browser-extension-action-icon'

/** Reads back the RGBA rows of a PNG made by encodeRgbaPng (one IDAT, filter 0 rows). */
function decodePng(png: Buffer): { width: number; height: number; rgba: number[] } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const idatStart = png.indexOf('IDAT') + 4
  const idatLength = png.readUInt32BE(idatStart - 8)
  const raw = inflateSync(png.subarray(idatStart, idatStart + idatLength))
  const rgba: number[] = []
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (width * 4 + 1), (y + 1) * (width * 4 + 1))
    expect(row[0]).toBe(0)
    rgba.push(...row.subarray(1))
  }
  return { width, height, rgba }
}

describe('action icons', () => {
  it('encodes ImageData pixels as a PNG without changing them', () => {
    const rgba = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]
    expect(decodePng(encodeRgbaPng(2, 2, rgba))).toEqual({ width: 2, height: 2, rgba })
  })

  it('keeps the smallest ImageData that still covers the toolbar at 2x', () => {
    const image = (side: number): { width: number; height: number; data: number[] } => ({
      width: side,
      height: side,
      data: Array.from({ length: side * side * 4 }, () => side)
    })
    const icon = iconFromImageData({ 16: image(16), 32: image(32), 64: image(64) })
    expect(icon?.kind).toBe('data')
    const dataUrl = icon?.kind === 'data' ? icon.dataUrl : ''
    const decoded = decodePng(Buffer.from(dataUrl.replace('data:image/png;base64,', ''), 'base64'))
    expect(decoded.width).toBe(32)
    expect(iconFromImageData({ width: 2, height: 2, data: [1, 2, 3] })).toBeNull()
  })

  it('prefers the first size at or above 32 px, else the largest', () => {
    const sizes = (list: number[]): { size: number; value: number }[] =>
      list.map((size) => ({ size, value: size }))
    expect(pickToolbarSize(sizes([16, 48, 128, 32]))).toBe(32)
    expect(pickToolbarSize(sizes([16, 19]))).toBe(19)
    expect(pickToolbarSize([])).toBeNull()
  })
})

describe('resolveActionIconDataUrl', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-action-icon-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves the extension file as a data URL and never reads outside the extension', async () => {
    writeFileSync(join(root, 'icon32.png'), Buffer.from([1, 2, 3]))
    await expect(
      resolveActionIconDataUrl(root, { kind: 'path', paths: { 16: 'x.png', 32: '/icon32.png' } })
    ).resolves.toBe('data:image/png;base64,AQID')
    await expect(
      resolveActionIconDataUrl(root, { kind: 'path', paths: { 32: '../outside.png' } })
    ).resolves.toBeNull()
  })
})
