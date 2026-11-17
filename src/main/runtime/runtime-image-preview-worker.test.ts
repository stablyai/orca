import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createJimp } from '@jimp/core'
import png from '@jimp/js-png'
import { shrinkImagePreviewInWorker } from './runtime-image-preview-worker'

describe('image preview worker', () => {
  let directory: string
  let entry: string
  let hanging: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-image-worker-'))
    entry = join(directory, 'preview.cjs')
    hanging = join(directory, 'hanging.cjs')
    await build({
      entryPoints: [resolve('src/main/runtime/runtime-image-preview-worker-entry.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    await writeFile(hanging, 'setInterval(() => {}, 1000)')
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('runs the bundled codec off the main thread and returns decodable bytes', async () => {
    const Image = createJimp({ formats: [png] })
    const image = new Image({ width: 1200, height: 1200, color: 0x123456ff })
    const source = await image.getBuffer('image/png')
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    try {
      const result = await shrinkImagePreviewInWorker(source, 4096, entry)
      expect(result.mimeType).toBe('image/jpeg')
      expect(result.bytes.length).toBeLessThanOrEqual(4096)
      expect(result.bytes.subarray(0, 2)).toEqual(Buffer.from([255, 216]))
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  }, 15_000)

  it('bounds concurrency, terminates timed-out workers, and releases their slots', async () => {
    const first = shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, hanging, 100)
    const second = shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, hanging, 100)
    const completions = Promise.allSettled([first, second])
    await expect(shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, hanging, 100)).rejects.toThrow(
      'busy'
    )
    expect((await completions).every((result) => result.status === 'rejected')).toBe(true)
    await expect(shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, hanging, 100)).rejects.toThrow(
      'timed out'
    )
  })

  it('propagates decoder failures and allows subsequent requests', async () => {
    await expect(shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, entry)).rejects.toThrow()
    await expect(shrinkImagePreviewInWorker(Buffer.alloc(0), 1024, hanging, 100)).rejects.toThrow(
      'timed out'
    )
  })
})
