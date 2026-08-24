import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileStat, IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  provider: undefined as IFilesystemProvider | undefined
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProviderSnapshot: () =>
    mocks.provider ? { provider: mocks.provider, generation: 1 } : null
}))

import { createSshTranscriptRangeFs } from './ssh-transcript-range-fs'
import { TranscriptRangeReadInvalidatedError } from './transcript-range-fs'

const TRANSCRIPT_PATH = '/tmp/rewrite.jsonl'

function mutableProvider(initial: string) {
  let bytes = Buffer.from(initial)
  let mtimeMs = 1
  const provider = {
    async stat(): Promise<FileStat> {
      return {
        size: bytes.length,
        type: 'file',
        mtime: mtimeMs,
        mtimeMs,
        dev: 7,
        ino: 11
      }
    },
    async readFileRange(_filePath: string, position: number, length: number) {
      const result = bytes.subarray(position, position + length)
      return { bytes: result, bytesRead: result.length }
    },
    async supportsFileRangeRead() {
      return true
    }
  } as unknown as IFilesystemProvider
  return {
    provider,
    replace(next: string, touch = true) {
      bytes = Buffer.from(next)
      if (touch) {
        mtimeMs++
      }
    }
  }
}

beforeEach(() => {
  mocks.provider = undefined
})

describe('SSH transcript range stability', () => {
  it.each([
    ['same-length rewrite', 'new generation'],
    ['growing rewrite', 'new generation with more bytes']
  ])('invalidates a %s', async (_label, replacement) => {
    const remote = mutableProvider('old generation')
    mocks.provider = remote.provider
    const rangeFs = await createSshTranscriptRangeFs('ssh-owner')
    const openingStamp = await rangeFs.stat(TRANSCRIPT_PATH, undefined, true)

    await rangeFs.read(TRANSCRIPT_PATH, 0, 3)
    remote.replace(replacement)

    await expect(rangeFs.assertStable(TRANSCRIPT_PATH, openingStamp)).rejects.toBeInstanceOf(
      TranscriptRangeReadInvalidatedError
    )
  })

  it('accepts a concurrent append that preserves the opening boundary', async () => {
    const remote = mutableProvider('old generation')
    mocks.provider = remote.provider
    const rangeFs = await createSshTranscriptRangeFs('ssh-owner')
    const openingStamp = await rangeFs.stat(TRANSCRIPT_PATH, undefined, true)

    remote.replace('old generation append')

    await expect(rangeFs.assertStable(TRANSCRIPT_PATH, openingStamp)).resolves.toBeUndefined()
  })

  it('rejects a growing rewrite even when remote mtime is coarse', async () => {
    const remote = mutableProvider('old generation')
    mocks.provider = remote.provider
    const rangeFs = await createSshTranscriptRangeFs('ssh-owner')
    const openingStamp = await rangeFs.stat(TRANSCRIPT_PATH, undefined, true)

    remote.replace('new generation with more bytes', false)

    await expect(rangeFs.assertStable(TRANSCRIPT_PATH, openingStamp)).rejects.toBeInstanceOf(
      TranscriptRangeReadInvalidatedError
    )
  })

  it('rejects a same-length rewrite even when remote mtime is coarse', async () => {
    const remote = mutableProvider('old generation')
    mocks.provider = remote.provider
    const rangeFs = await createSshTranscriptRangeFs('ssh-owner')
    const openingStamp = await rangeFs.stat(TRANSCRIPT_PATH, undefined, true)

    remote.replace('new generation', false)

    await expect(rangeFs.assertStable(TRANSCRIPT_PATH, openingStamp)).rejects.toBeInstanceOf(
      TranscriptRangeReadInvalidatedError
    )
  })
})
