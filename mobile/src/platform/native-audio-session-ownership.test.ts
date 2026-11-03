import { afterEach, describe, expect, it } from 'vitest'
import { createNativeAudioCapture, type NativeAudioEngine } from './native-audio'
import { audioReadResultSchema } from '../mobile-web-shell/bridge/bridge-audio-verbs'

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function device(blockAt?: 'permission' | 'open') {
  const entered = gate()
  const blocked = gate()
  const listeners = new Set<(bytes: Uint8Array) => void>()
  let permissions = 0
  let opens = 0
  let recording = false
  let holds = 0
  const engine: NativeAudioEngine = {
    requestPermission: async () => {
      permissions++
      if (blockAt === 'permission' && permissions === 1) {
        entered.release()
        await blocked.promise
      }
      return 'granted'
    },
    open: async (sampleRate) => {
      opens++
      if (blockAt === 'open' && opens === 1) {
        entered.release()
        await blocked.promise
      }
      return { opened: true, sampleRate }
    },
    begin: () => {
      recording = true
      return true
    },
    end: () => {
      recording = false
    },
    screenLock: {
      hold: () => {
        holds++
      },
      release: () => {
        holds--
      }
    },
    onMicrophoneData: (listener) => {
      listeners.add(listener)
      return {
        remove: () => {
          listeners.delete(listener)
        }
      }
    },
    onInterruption: () => ({ remove: () => {} })
  }
  return {
    engine,
    entered,
    blocked,
    counts: () => ({ permissions, opens, recording, holds, listeners: listeners.size }),
    emit: (bytes: Uint8Array) => {
      if (recording) {
        for (const listener of listeners) {
          listener(bytes)
        }
      }
    }
  }
}

const captures = new Set<ReturnType<typeof createNativeAudioCapture>>()
function capture(engine: NativeAudioEngine) {
  const next = createNativeAudioCapture(engine)
  captures.add(next)
  return next
}
afterEach(() => {
  for (const current of captures) {
    current.dispose()
  }
  captures.clear()
})

async function read(current: ReturnType<typeof createNativeAudioCapture>) {
  const reply = audioReadResultSchema.parse(
    await current.serve('native.audio.read', { maxBytes: 1024 })
  )
  return Uint8Array.from(atob(reply.base64), (char) => char.charCodeAt(0))
}

describe('page sessions sharing the device microphone', () => {
  it.each(['permission', 'open'] as const)(
    'keeps the successor recording after a retired %s finishes',
    async (blockAt) => {
      const mic = device(blockAt)
      const retired = capture(mic.engine)
      const obsolete = retired.serve('native.audio.start', { sampleRate: 16_000 })
      await mic.entered.promise
      retired.dispose()
      const successor = capture(mic.engine)
      const live = successor.serve('native.audio.start', { sampleRate: 16_000 })
      // Let runnable starts settle while the older native operation remains explicitly blocked.
      await new Promise<void>((resolve) => setImmediate(resolve))
      mic.blocked.release()
      await expect(obsolete).resolves.toMatchObject({ started: false })
      await expect(live).resolves.toMatchObject({ started: true })
      const speech = new Uint8Array([1, 3, 5, 7])
      mic.emit(speech)
      expect(await read(successor)).toEqual(speech)
      expect(mic.counts()).toMatchObject({ recording: true, holds: 1, listeners: 1 })
      successor.dispose()
      expect(mic.counts()).toMatchObject({ recording: false, holds: 0, listeners: 0 })
    }
  )

  it('transfers a live microphone without leaving the old page listening or able to stop its successor', async () => {
    const mic = device()
    const previous = capture(mic.engine)
    await previous.serve('native.audio.start', { sampleRate: 16_000 })
    const successor = capture(mic.engine)
    await successor.serve('native.audio.start', { sampleRate: 16_000 })
    expect(mic.counts()).toMatchObject({ holds: 1, listeners: 1 })
    await expect(read(previous)).rejects.toThrow('no capture')
    previous.dispose()
    await previous.serve('native.audio.stop', {})
    const speech = new Uint8Array([2, 4, 6, 8])
    mic.emit(speech)
    expect(await read(successor)).toEqual(speech)
  })

  it.each([10, 100])(
    'skips device admission for %i starts queued before retirement',
    async (count) => {
      const mic = device('permission')
      const retired = capture(mic.engine)
      const pending = Array.from({ length: count }, () =>
        retired.serve('native.audio.start', { sampleRate: 16_000 })
      )
      await mic.entered.promise
      retired.dispose()
      const successor = capture(mic.engine)
      const live = successor.serve('native.audio.start', { sampleRate: 16_000 })
      mic.blocked.release()
      await Promise.all(pending)
      await expect(live).resolves.toMatchObject({ started: true })
      expect(mic.counts()).toEqual({
        permissions: 2,
        opens: 1,
        recording: true,
        holds: 1,
        listeners: 1
      })
      const speech = new Uint8Array([9, 10])
      mic.emit(speech)
      expect(await read(successor)).toEqual(speech)
    }
  )
})
