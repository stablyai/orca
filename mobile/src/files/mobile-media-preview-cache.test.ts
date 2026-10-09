import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'buffer/index.js'

const state = vi.hoisted(() => ({ write: vi.fn(), close: vi.fn(), remove: vi.fn(), open: vi.fn() }))
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: class {
    exists = true
    uri = 'file:///cache/media.mp4'
    create() {}
    open() {
      state.open()
      return { writeBytes: state.write, close: state.close }
    }
    delete() {
      this.exists = false
      state.remove()
    }
  }
}))
import { createMobileMediaSink } from './mobile-media-preview-cache'

beforeEach(() => {
  vi.clearAllMocks()
  state.open.mockReset()
})
describe('native media staging', () => {
  it('writes chunks through one handle and deletes the file after playback', () => {
    const sink = createMobileMediaSink('movie.mp4', 'video/mp4')
    const bytes = new Uint8Array([1, 2, 3])
    sink.append(bytes)
    expect(state.write).toHaveBeenCalledWith(bytes)
    expect(sink.finish()).toBe('file:///cache/media.mp4')
    expect(state.close).toHaveBeenCalledOnce()
    sink.dispose()
    sink.dispose()
    expect(state.close).toHaveBeenCalledOnce()
    expect(state.remove).toHaveBeenCalledOnce()
    expect(() => sink.append(bytes)).toThrow('closed')
  })
  it('closes and deletes a partially downloaded file', () => {
    const sink = createMobileMediaSink('song.mp3', 'audio/mpeg')
    sink.dispose()
    expect(state.close).toHaveBeenCalledOnce()
    expect(state.remove).toHaveBeenCalledOnce()
  })
  it('converts decoded Buffer chunks to the native writer’s supported typed array', () => {
    state.write.mockImplementation((bytes: Uint8Array) => {
      if (bytes.constructor !== Uint8Array) {
        throw new Error('unsupported typed array')
      }
    })
    const sink = createMobileMediaSink('movie.mp4', 'video/mp4')
    sink.append(Buffer.from('AQID', 'base64'))
    expect(state.write.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]))
    sink.dispose()
  })
  it('removes the file when opening its handle fails', () => {
    state.open.mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    expect(() => createMobileMediaSink('song.mp3', 'audio/mpeg')).toThrow('disk unavailable')
    expect(state.remove).toHaveBeenCalledOnce()
  })
})
