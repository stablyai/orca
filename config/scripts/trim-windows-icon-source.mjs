#!/usr/bin/env node
// Build the Windows multi-size ICO from the macOS 1024px render, trimming the
// transparent Icon Composer "safe-area" inset so the glyph fills the canvas the
// way other Windows taskbar/"Open with" icons do. Without this the glyph is only
// ~83% of the frame and looks visibly small next to native apps (issue #5357).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

// Why: Windows renders the largest ICO frame at small sizes too, so the glyph
// must fill nearly the whole canvas (~96%) to match native apps. A small uniform
// margin keeps anti-aliased edges and the soft shadow from clipping at the border.
export const ICON_CANVAS_MARGIN_RATIO = 0.02
// Why: alpha below this is treated as background; the macOS render fades the
// safe-area shadow to a few percent opacity, which must not count as glyph.
const ALPHA_BACKGROUND_THRESHOLD = 16
// Standard Windows ICO sizes, largest first (matches the prior ImageMagick set).
export const ICO_FRAME_SIZES = [256, 128, 64, 48, 32, 16]

export function decodePng(buffer) {
  const png = PNG.sync.read(buffer)
  return { width: png.width, height: png.height, data: png.data }
}

export function encodePng({ width, height, data }) {
  const png = new PNG({ width, height })
  data.copy(png.data)
  return PNG.sync.write(png)
}

// Tightest box containing every pixel whose alpha exceeds the background
// threshold. Returns null when the image is fully transparent.
export function findOpaqueBounds({ width, height, data }, threshold = ALPHA_BACKGROUND_THRESHOLD) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > threshold) {
        if (x < minX) {
          minX = x
        }
        if (x > maxX) {
          maxX = x
        }
        if (y < minY) {
          minY = y
        }
        if (y > maxY) {
          maxY = y
        }
      }
    }
  }
  if (maxX < 0) {
    return null
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Crop an RGBA image to the given inclusive bounds.
export function cropImage({ width, data }, bounds) {
  const cropWidth = bounds.width
  const cropHeight = bounds.height
  const out = Buffer.alloc(cropWidth * cropHeight * 4)
  for (let y = 0; y < cropHeight; y++) {
    const srcRow = (bounds.minY + y) * width + bounds.minX
    const srcStart = srcRow * 4
    out.set(data.subarray(srcStart, srcStart + cropWidth * 4), y * cropWidth * 4)
  }
  return { width: cropWidth, height: cropHeight, data: out }
}

// Center the (already-trimmed) glyph on a transparent square canvas, leaving a
// small uniform margin so edges/shadow do not clip. The square side is the
// glyph's longer dimension grown by the margin so the glyph keeps its shape.
export function squareWithMargin(image, marginRatio = ICON_CANVAS_MARGIN_RATIO) {
  const longSide = Math.max(image.width, image.height)
  const side = Math.round(longSide / (1 - 2 * marginRatio))
  const data = Buffer.alloc(side * side * 4)
  const offsetX = Math.floor((side - image.width) / 2)
  const offsetY = Math.floor((side - image.height) / 2)
  for (let y = 0; y < image.height; y++) {
    const srcStart = y * image.width * 4
    const dstStart = ((offsetY + y) * side + offsetX) * 4
    data.set(image.data.subarray(srcStart, srcStart + image.width * 4), dstStart)
  }
  return { width: side, height: side, data }
}

// Area-averaging (box filter) resize with premultiplied alpha so transparent
// edges do not bleed dark fringes. Used to downscale to each ICO frame size.
export function resizeImage(image, targetWidth, targetHeight) {
  const { width: srcW, height: srcH, data: src } = image
  const out = Buffer.alloc(targetWidth * targetHeight * 4)
  const scaleX = srcW / targetWidth
  const scaleY = srcH / targetHeight
  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = ty * scaleY
    const sy1 = (ty + 1) * scaleY
    const y0 = Math.floor(sy0)
    const y1 = Math.min(srcH, Math.ceil(sy1))
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = tx * scaleX
      const sx1 = (tx + 1) * scaleX
      const x0 = Math.floor(sx0)
      const x1 = Math.min(srcW, Math.ceil(sx1))
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let aSum = 0
      let weightSum = 0
      for (let sy = y0; sy < y1; sy++) {
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy)
        for (let sx = x0; sx < x1; sx++) {
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx)
          const weight = wx * wy
          if (weight <= 0) {
            continue
          }
          const idx = (sy * srcW + sx) * 4
          const alpha = src[idx + 3]
          const premul = (alpha / 255) * weight
          rSum += src[idx] * premul
          gSum += src[idx + 1] * premul
          bSum += src[idx + 2] * premul
          aSum += alpha * weight
          weightSum += weight
        }
      }
      const dst = (ty * targetWidth + tx) * 4
      if (weightSum === 0 || aSum === 0) {
        out[dst] = 0
        out[dst + 1] = 0
        out[dst + 2] = 0
        out[dst + 3] = 0
        continue
      }
      const alphaAvg = aSum / weightSum
      const colorDivisor = alphaAvg / 255
      out[dst] = Math.round(rSum / weightSum / colorDivisor)
      out[dst + 1] = Math.round(gSum / weightSum / colorDivisor)
      out[dst + 2] = Math.round(bSum / weightSum / colorDivisor)
      out[dst + 3] = Math.round(alphaAvg)
    }
  }
  return { width: targetWidth, height: targetHeight, data: out }
}

// Encode a Windows .ico holding PNG-compressed frames (supported since Vista,
// the format ImageMagick's auto-resize also emits for the larger sizes).
export function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(frames.length, 4)

  const directory = Buffer.alloc(frames.length * 16)
  let dataOffset = 6 + frames.length * 16
  const payloads = []
  frames.forEach((frame, index) => {
    const png = encodePng(frame)
    payloads.push(png)
    const entry = index * 16
    // Width/height of 256 are stored as 0 per the ICO spec.
    directory.writeUInt8(frame.width >= 256 ? 0 : frame.width, entry)
    directory.writeUInt8(frame.height >= 256 ? 0 : frame.height, entry + 1)
    directory.writeUInt8(0, entry + 2) // color count (0 = truecolor)
    directory.writeUInt8(0, entry + 3) // reserved
    directory.writeUInt16LE(1, entry + 4) // color planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(dataOffset, entry + 12)
    dataOffset += png.length
  })

  return Buffer.concat([header, directory, ...payloads])
}

// Trim the safe-area inset from a 1024px source render and produce a filled
// multi-size ICO buffer. Exported so the regression test can drive it directly.
export function buildWindowsIcoFromPng(sourcePngBuffer, sizes = ICO_FRAME_SIZES) {
  const source = decodePng(sourcePngBuffer)
  const bounds = findOpaqueBounds(source)
  if (!bounds) {
    throw new Error('Source icon is fully transparent; cannot trim safe-area inset.')
  }
  const trimmed = cropImage(source, bounds)
  const filled = squareWithMargin(trimmed)
  const frames = sizes.map((size) => resizeImage(filled, size, size))
  return encodeIco(frames)
}

function resolveDefaultPaths() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const projectDir = dirname(dirname(scriptDir))
  return {
    sourcePng: join(projectDir, 'resources', 'build', 'icon.png'),
    outputIco: join(projectDir, 'resources', 'build', 'icon.ico')
  }
}

function main() {
  const { sourcePng, outputIco } = resolveDefaultPaths()
  if (!existsSync(sourcePng)) {
    console.error(`Error: source PNG not found at ${sourcePng}`)
    process.exit(1)
  }
  const ico = buildWindowsIcoFromPng(readFileSync(sourcePng))
  writeFileSync(outputIco, ico)
  console.log(`  -> ${outputIco} (filled multi-size ICO, safe-area inset trimmed)`)
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('trim-windows-icon-source.mjs')
) {
  main()
}
