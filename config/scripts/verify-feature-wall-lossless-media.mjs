#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { runProcessSync } from '@orca/process-host'
import { FEATURE_WALL_TILES, isFeatureWallMediaTile } from '../../src/shared/feature-wall-tiles.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const ASSET_DIR = 'resources/onboarding/feature-wall'

function skipGifSubBlocks(bytes, offset) {
  while (offset < bytes.length && bytes[offset] !== 0) {
    offset += 1 + bytes[offset]
  }
  assert.ok(offset < bytes.length, 'Truncated GIF sub-block')
  return offset + 1
}

function gifDurations(bytes) {
  assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/)
  let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0)
  let duration = 0
  const durations = []
  while (offset < bytes.length) {
    const block = bytes[offset++]
    if (block === 0x3b) {
      return durations
    }
    if (block === 0x21) {
      const label = bytes[offset++]
      if (label === 0xf9) {
        duration = bytes.readUInt16LE(offset + 2) * 10
      }
      offset = skipGifSubBlocks(bytes, offset)
    } else {
      assert.equal(block, 0x2c, 'Invalid GIF image descriptor')
      const packed = bytes[offset + 8]
      offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0)
      offset = skipGifSubBlocks(bytes, offset + 1)
      durations.push(duration)
      duration = 0
    }
  }
  throw new Error('Missing GIF trailer')
}

function animationDurations(bytes) {
  if (bytes.subarray(0, 3).toString() === 'GIF') {
    return gifDurations(bytes)
  }
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString(), 'WEBP')
  const durations = []
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4)
    if (bytes.subarray(offset, offset + 4).toString() === 'ANMF') {
      durations.push(bytes.readUIntLE(offset + 20, 3))
    }
    offset += 8 + length + (length % 2)
  }
  return durations
}

export async function verifyLosslessFeatureWallMedia(
  originals,
  candidateDirectory = path.join(ROOT, ASSET_DIR)
) {
  const candidates = new Map()
  for (const tile of FEATURE_WALL_TILES.filter(isFeatureWallMediaTile)) {
    const candidate = await readFile(path.join(candidateDirectory, tile.gifPath))
    const original = originals.get(tile.id)
    assert.ok(original, `${tile.id}: original GIF missing`)
    assert.deepEqual(
      animationDurations(candidate),
      animationDurations(original),
      `${tile.id}: encoded per-frame timing changed`
    )
    candidates.set(tile.id, candidate)
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/') {
      return response.end('<!doctype html><title>Animation equality</title>')
    }
    const [kind, id] = request.url.slice(1).split('/')
    const bytes = (kind === 'original' ? originals : candidates).get(id)
    response.statusCode = bytes ? 200 : 404
    response.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORCA_ANIMATION_CHROMIUM_EXECUTABLE || undefined
    })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const results = []
    for (const tile of FEATURE_WALL_TILES.filter(isFeatureWallMediaTile)) {
      const result = await page.evaluate(async ({ id, gifPath }) => {
        const makeDecoder = async (kind, type) =>
          new ImageDecoder({
            data: await (await fetch(`/${kind}/${id}`)).arrayBuffer(),
            type,
            preferAnimation: true
          })
        const original = await makeDecoder('original', 'image/gif')
        const candidate = await makeDecoder(
          'candidate',
          gifPath.endsWith('.gif') ? 'image/gif' : 'image/webp'
        )
        try {
          await Promise.all([original.tracks.ready, candidate.tracks.ready])
          const a = original.tracks.selectedTrack
          const b = candidate.tracks.selectedTrack
          if (a.frameCount !== b.frameCount || a.repetitionCount !== b.repetitionCount) {
            throw new Error(`${id}: frame count or loop changed`)
          }
          let canvas, context
          let durationUs = 0
          for (let frameIndex = 0; frameIndex < a.frameCount; frameIndex++) {
            const first = (await original.decode({ frameIndex })).image
            const second = (await candidate.decode({ frameIndex })).image
            try {
              if (
                first.displayWidth !== second.displayWidth ||
                first.displayHeight !== second.displayHeight ||
                first.duration !== second.duration ||
                first.timestamp !== second.timestamp
              ) {
                throw new Error(`${id}: dimensions or playback timing changed at ${frameIndex}`)
              }
              if (!canvas) {
                canvas = new OffscreenCanvas(first.displayWidth, first.displayHeight)
                context = canvas.getContext('2d', { willReadFrequently: true })
              }
              context.clearRect(0, 0, canvas.width, canvas.height)
              context.drawImage(first, 0, 0)
              const left = context.getImageData(0, 0, canvas.width, canvas.height).data
              context.clearRect(0, 0, canvas.width, canvas.height)
              context.drawImage(second, 0, 0)
              const right = context.getImageData(0, 0, canvas.width, canvas.height).data
              const leftPixels = new Uint32Array(left.buffer)
              const rightPixels = new Uint32Array(right.buffer)
              for (let index = 0; index < leftPixels.length; index++) {
                if (leftPixels[index] !== rightPixels[index]) {
                  throw new Error(`${id}: RGBA pixel ${index} changed at frame ${frameIndex}`)
                }
              }
              durationUs += first.duration
            } finally {
              first.close()
              second.close()
            }
          }
          return { id, frames: a.frameCount, durationUs, exactRGBA: true }
        } finally {
          original.close()
          candidate.close()
        }
      }, tile)
      results.push(result)
      console.log(JSON.stringify(result))
    }
    return results
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

function readOriginalGif(baseRef, id) {
  const result = runProcessSync({
    program: 'git',
    args: ['show', `${baseRef}:${ASSET_DIR}/${id}.gif`],
    cwd: ROOT,
    maxOutputBytes: 16 * 1024 * 1024,
    captureStdoutAsBytes: true
  })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.stdoutBytes)
  return result.stdoutBytes
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const baseRef = process.argv[2]
  assert.ok(baseRef, 'Usage: node config/scripts/verify-feature-wall-lossless-media.mjs <base-ref>')
  const originals = new Map(
    FEATURE_WALL_TILES.filter(isFeatureWallMediaTile).map((tile) => [
      tile.id,
      readOriginalGif(baseRef, tile.id)
    ])
  )
  await verifyLosslessFeatureWallMedia(originals)
}
