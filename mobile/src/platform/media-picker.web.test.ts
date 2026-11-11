import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  mediaNameResultSchema,
  mediaPickLargeResultSchema,
  mediaPickResultSchema,
  mediaReadResultSchema,
  mediaReleaseResultSchema
} from '../mobile-web-shell/bridge/bridge-media-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { MobileFileTooLargeError, type MediaPicker } from './media-picker-contract'
import {
  createMediaTestShell,
  stagedTestBytes,
  type MediaTestShell,
  type StagedTestMedia
} from './media-picker-test-shell'

const state = vi.hoisted(() => ({ verbs: null as unknown }))

vi.mock('../mobile-web-shell/bridge/use-native-verbs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mobile-web-shell/bridge/use-native-verbs')>()),
  useNativeVerbs: () => state.verbs
}))

import { NativeVerbError } from '../mobile-web-shell/bridge/use-native-verbs'
import { useMediaPicker } from './media-picker.web'

function mountPicker(shell: MediaTestShell, options: { large: boolean }): MediaPicker {
  const call = async <T>(
    verb: Parameters<MediaTestShell['serveNativeVerb']>[0],
    params: unknown,
    parse: (value: unknown) => T
  ): Promise<T> => {
    try {
      return parse(await shell.serveNativeVerb(verb, params))
    } catch (error) {
      if (error instanceof BridgeNativeVerbRefusedError) {
        throw new NativeVerbError(
          error.code as ConstructorParameters<typeof NativeVerbError>[0],
          error.message
        )
      }
      throw error
    }
  }
  state.verbs = {
    canPickMedia: true,
    canNameMedia: true,
    canPickLargeFile: options.large,
    pickMedia: async (source: string, multiple: boolean) =>
      (await call('native.media.pick', { source, multiple }, mediaPickResultSchema.parse)).items,
    pickLargeFile: async () =>
      (await call('native.media.picklarge', {}, mediaPickLargeResultSchema.parse)).items,
    readMedia: (handle: string, offset: number, length: number) =>
      call('native.media.read', { handle, offset, length }, mediaReadResultSchema.parse),
    releaseMedia: async (handle: string) =>
      (await call('native.media.release', { handle }, mediaReleaseResultSchema.parse)).released,
    nameMedia: async (handle: string) =>
      (await call('native.media.name', { handle }, mediaNameResultSchema.parse)).name
  }
  let picker: MediaPicker | null = null
  function Probe(): null {
    picker = useMediaPicker()
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  if (picker === null) {
    throw new Error('no picker')
  }
  return picker
}

const CHUNK = 393216

function pdf(byteLength: number): StagedTestMedia {
  return { bytes: stagedTestBytes(byteLength), mime: 'application/pdf', name: 'big.pdf' }
}

function joined(chunks: readonly string[]): Uint8Array {
  return Uint8Array.from(atob(chunks.join('')), (char) => char.charCodeAt(0))
}

describe('pickFiles', () => {
  it('streams a large pick chunk by chunk', async () => {
    const media = pdf(CHUNK * 2)
    const shell = createMediaTestShell({ staged: { files: [media] }, chunkBytes: 1000 })
    const picker = mountPicker(shell, { large: true })

    const seen: string[] = []
    for await (const file of picker.pickFiles()) {
      expect(file).toMatchObject({ name: 'big.pdf', byteLength: media.bytes.byteLength })
      for await (const chunk of file.chunks()) {
        expect(shell.released).toEqual([])
        seen.push(chunk)
      }
    }

    expect(seen).toHaveLength(2)
    expect(joined(seen)).toEqual(media.bytes)
    expect(shell.released).toEqual(['media-1'])
    expect(shell.calls[0]).toBe('picklarge files single')
  })

  it('yields no chunks for a 0-byte file and still releases it', async () => {
    const shell = createMediaTestShell({ staged: { files: [pdf(0)] } })
    const picker = mountPicker(shell, { large: true })

    for await (const file of picker.pickFiles()) {
      const seen: string[] = []
      for await (const chunk of file.chunks()) {
        seen.push(chunk)
      }
      expect(seen).toEqual([])
    }

    expect(shell.released).toEqual(['media-1'])
  })

  it("releases each file's handle before offering the next, read or not", async () => {
    const shell = createMediaTestShell({ staged: { files: [pdf(10), pdf(20)] } })
    const picker = mountPicker(shell, { large: false })

    const releasedWhenOffered: string[][] = []
    for await (const file of picker.pickFiles()) {
      expect(file.byteLength).toBeGreaterThan(0)
      releasedWhenOffered.push([...shell.released])
    }

    expect(releasedWhenOffered).toEqual([[], ['media-1']])
    expect(shell.released).toEqual(['media-1', 'media-2'])
  })

  it('releases every handle when the consumer stops after the first file', async () => {
    const shell = createMediaTestShell({ staged: { files: [pdf(10), pdf(20)] } })
    const picker = mountPicker(shell, { large: false })

    for await (const file of picker.pickFiles()) {
      expect(file.byteLength).toBe(10)
      break
    }

    expect(shell.released.sort()).toEqual(['media-1', 'media-2'])
  })

  it('releases the handle as soon as its consumer stops reading chunks', async () => {
    const shell = createMediaTestShell({ staged: { files: [pdf(CHUNK * 2)] } })
    const picker = mountPicker(shell, { large: true })

    for await (const file of picker.pickFiles()) {
      for await (const chunk of file.chunks()) {
        expect(chunk.length).toBeGreaterThan(0)
        break
      }
      expect(shell.released).toEqual(['media-1'])
    }
  })

  it('releases the handle when reading fails part way, before the next file is asked for', async () => {
    const shell = createMediaTestShell({ staged: { files: [pdf(CHUNK * 2)] }, endAt: CHUNK })
    const picker = mountPicker(shell, { large: true })

    for await (const file of picker.pickFiles()) {
      const read = (async () => {
        for await (const chunk of file.chunks()) {
          expect(chunk.length).toBeGreaterThan(0)
        }
      })()
      await expect(read).rejects.toThrow('declared')
      expect(shell.released).toEqual(['media-1'])
    }
  })

  it('asks to update an old shell that refuses a file over its ceiling', async () => {
    const shell = createMediaTestShell({
      staged: {},
      refusePick: new BridgeNativeVerbRefusedError('native_media_too_large', 'too large')
    })
    const picker = mountPicker(shell, { large: false })

    const error = await (async () => {
      for await (const file of picker.pickFiles()) {
        expect(file).toBeUndefined()
      }
    })().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MobileFileTooLargeError)
    expect(error).toMatchObject({ reason: 'update-app' })
    expect(shell.calls).toEqual(['pick files multiple'])
  })

  it('reports the limit when the large-file verb refuses', async () => {
    const shell = createMediaTestShell({
      staged: {},
      refusePick: new BridgeNativeVerbRefusedError('native_media_too_large', 'too large')
    })
    const picker = mountPicker(shell, { large: true })

    const error = await (async () => {
      for await (const file of picker.pickFiles()) {
        expect(file).toBeUndefined()
      }
    })().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ reason: 'limit' })
  })
})
