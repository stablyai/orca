import { describe, expect, it } from 'vitest'
import {
  composeMacAppIconBitmap,
  getMacAppIconTileGeometry,
  isFullBleedIconBitmap
} from './mac-app-icon-template'

function solidBitmap(side: number, rgba: [number, number, number, number]): Uint8Array {
  const bitmap = new Uint8Array(side * side * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap.set(rgba, i)
  }
  return bitmap
}

function pixel(bitmap: Uint8Array, side: number, x: number, y: number): number[] {
  const index = (y * side + x) * 4
  return Array.from(bitmap.subarray(index, index + 4))
}

describe('composeMacAppIconBitmap', () => {
  it('fits full-bleed art into the 824px continuous-corner tile with a margin and shadow', () => {
    const geometry = getMacAppIconTileGeometry(1024)
    expect(geometry).toEqual({ side: 1024, tileOffset: 100, tileSide: 824 })
    const shaped = composeMacAppIconBitmap(solidBitmap(824, [40, 160, 90, 255]), geometry)

    expect(pixel(shaped, 1024, 512, 512)).toEqual([40, 160, 90, 255])
    expect(pixel(shaped, 1024, 100, 512)).toEqual([40, 160, 90, 255])
    // The square tile's corner is cut away by the rounded shape.
    expect(pixel(shaped, 1024, 110, 110)).toEqual([0, 0, 0, 0])
    expect(pixel(shaped, 1024, 0, 0)).toEqual([0, 0, 0, 0])
    // Soft shadow below the tile, as in Apple's template.
    expect(pixel(shaped, 1024, 512, 935)).toEqual([0, 0, 0, 26])
  })
})

describe('isFullBleedIconBitmap', () => {
  it('shapes opaque squares but leaves art with any transparent corner', () => {
    expect(isFullBleedIconBitmap(solidBitmap(64, [0, 0, 0, 255]), 64)).toBe(true)
    const geometry = getMacAppIconTileGeometry(64)
    const alreadyShaped = composeMacAppIconBitmap(
      solidBitmap(geometry.tileSide, [0, 0, 0, 255]),
      geometry
    )
    expect(isFullBleedIconBitmap(alreadyShaped, 64)).toBe(false)
    // A 2×2 clear corner on 1024px art barely moves a corner patch's mean alpha.
    const tinyClearCorner = solidBitmap(1024, [0, 0, 0, 255])
    for (const index of [0, 1, 1024, 1025]) {
      tinyClearCorner[index * 4 + 3] = 0
    }
    expect(isFullBleedIconBitmap(tinyClearCorner, 1024)).toBe(false)
  })
})
