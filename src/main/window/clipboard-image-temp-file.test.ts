import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ temp: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => environment.temp })
}))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

describe('saveClipboardImageBufferAsTempFile', () => {
  beforeEach(async () => {
    environment.temp = await mkdtemp(path.join(tmpdir(), 'orca-clipboard-name-'))
  })

  afterEach(async () => {
    await rm(environment.temp, { recursive: true, force: true })
  })

  it.each([
    ['HEIC', Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00', 'latin1'), /\.heic$/],
    ['TIFF', Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]), /\.tiff$/],
    ['unrecognised', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), /^orca-paste-[^.]+$/]
  ])('names %s bytes by what they are, never .png', async (_label, bytes, expected) => {
    const saved = await saveClipboardImageBufferAsTempFile(bytes)

    expect(path.basename(saved)).toMatch(expected)
  })
})
