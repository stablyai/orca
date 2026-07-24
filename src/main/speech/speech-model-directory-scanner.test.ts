import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirMock, opendirSyncMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  opendirSyncMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  opendirSync: opendirSyncMock
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  opendir: opendirMock
}))

import {
  findNestedSpeechModelDirectory,
  findSpeechModelBpeVocabFile,
  SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES,
  SpeechModelDirectoryCapacityError
} from './speech-model-directory-scanner'
import { buildHotwordsConfig } from './stt-worker-model-config'

type FakeEntry = { name: string; directory?: boolean }

function fakeAsyncDirectory(entries: FakeEntry[], onClose?: () => void): object {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const entry of entries) {
          yield {
            name: entry.name,
            isDirectory: () => entry.directory === true
          }
        }
      } finally {
        onClose?.()
      }
    }
  }
}

function useSyncEntries(entries: FakeEntry[]): ReturnType<typeof vi.fn> {
  let index = 0
  const closeSync = vi.fn()
  opendirSyncMock.mockReturnValue({
    closeSync,
    readSync: vi.fn(() => {
      const entry = entries[index]
      index += 1
      return entry ? { name: entry.name } : null
    })
  })
  return closeSync
}

describe('speech model directory scanner', () => {
  beforeEach(() => {
    opendirMock.mockReset()
    opendirSyncMock.mockReset()
  })

  it('preserves the first matching nested directory and its entry order', async () => {
    opendirMock.mockImplementation(async (path: string) => {
      if (path === '/models') {
        return fakeAsyncDirectory([
          { name: 'unrelated', directory: true },
          { name: 'archive', directory: true }
        ])
      }
      if (path === '/models/unrelated') {
        return fakeAsyncDirectory([{ name: 'README.md' }])
      }
      return fakeAsyncDirectory([{ name: 'encoder.onnx' }, { name: 'tokens.txt' }])
    })

    await expect(findNestedSpeechModelDirectory('/models', ['encoder.onnx'])).resolves.toEqual({
      directoryPath: '/models/archive',
      entryNames: ['encoder.onnx', 'tokens.txt']
    })
  })

  it('accepts the exact archive entry limit', async () => {
    opendirMock.mockImplementation(async (path: string) =>
      path === '/models'
        ? fakeAsyncDirectory([{ name: 'archive', directory: true }])
        : fakeAsyncDirectory([{ name: 'encoder.onnx' }, { name: 'tokens.txt' }])
    )

    await expect(
      findNestedSpeechModelDirectory('/models', ['encoder.onnx'], {
        maxEntries: 3
      })
    ).resolves.toMatchObject({ entryNames: ['encoder.onnx', 'tokens.txt'] })
  })

  it('closes both streams and rejects the first entry over the archive limit', async () => {
    const closed: string[] = []
    opendirMock.mockImplementation(async (path: string) =>
      path === '/models'
        ? fakeAsyncDirectory([{ name: 'archive', directory: true }], () => closed.push('root'))
        : fakeAsyncDirectory([{ name: 'one' }, { name: 'two' }, { name: 'three' }], () =>
            closed.push('nested')
          )
    )

    await expect(
      findNestedSpeechModelDirectory('/models', ['missing'], {
        maxEntries: 3
      })
    ).rejects.toBeInstanceOf(SpeechModelDirectoryCapacityError)
    expect(closed).toEqual(['nested', 'root'])
  })

  it('rejects a nested listing above its retained-name budget', async () => {
    opendirMock.mockImplementation(async (path: string) =>
      path === '/models'
        ? fakeAsyncDirectory([{ name: 'archive', directory: true }])
        : fakeAsyncDirectory([{ name: 'x' }])
    )

    await expect(
      findNestedSpeechModelDirectory('/models', ['x'], {
        maxRetainedNameBytes: 65
      })
    ).rejects.toThrow('retained name bytes')
  })

  it('finds a vocab at the exact production scan boundary', () => {
    const entries = Array.from({ length: SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES - 1 }, (_, index) => ({
      name: `file-${index}`
    }))
    entries.push({ name: 'tokens.vocab' })
    const closeSync = useSyncEntries(entries)

    expect(
      buildHotwordsConfig({
        modelDir: '/models',
        modelType: 'transducer',
        hotwordsFilePath: '/hotwords.txt',
        modelingUnit: 'bpe'
      })
    ).toMatchObject({
      decodingMethod: 'modified_beam_search',
      bpeVocab: '/models/tokens.vocab'
    })
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('ignores a vocab beyond the production scan boundary and closes the stream', () => {
    const entries = Array.from({ length: SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES }, (_, index) => ({
      name: `file-${index}`
    }))
    entries.push({ name: 'too-late.vocab' })
    const closeSync = useSyncEntries(entries)

    expect(
      buildHotwordsConfig({
        modelDir: '/models',
        modelType: 'transducer',
        hotwordsFilePath: '/hotwords.txt',
        modelingUnit: 'bpe'
      })
    ).toEqual({ decodingMethod: 'greedy_search' })
    expect(findSpeechModelBpeVocabFile('/models', 0)).toBeUndefined()
    expect(closeSync).toHaveBeenCalledTimes(2)
  })
})
