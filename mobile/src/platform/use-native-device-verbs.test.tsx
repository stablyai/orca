import { StrictMode, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PickerResult = { canceled: boolean; assets?: { uri: string; mimeType: string }[] }

const device = vi.hoisted(() => ({
  clipboard: { getStringAsync: vi.fn(() => Promise.resolve('on the pasteboard')) },
  picker: {
    launchImageLibraryAsync: vi.fn((): Promise<PickerResult> =>
      Promise.resolve({ canceled: true })
    ),
    getDocumentAsync: vi.fn((): Promise<PickerResult> => Promise.resolve({ canceled: true }))
  },
  files: new Map<string, Uint8Array>(),
  deleted: new Array<string>(),
  wakeTags: new Array<string>()
}))

vi.mock('expo-clipboard', () => ({
  setStringAsync: () => Promise.resolve(true),
  getStringAsync: device.clipboard.getStringAsync,
  getImageAsync: () => Promise.resolve(null)
}))
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: device.picker.getDocumentAsync
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () =>
    Promise.resolve({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (tag: string) => {
    device.wakeTags.push(`+${tag}`)
    return Promise.resolve()
  },
  deactivateKeepAwake: (tag: string) => {
    device.wakeTags.push(`-${tag}`)
    return Promise.resolve()
  }
}))
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: device.picker.launchImageLibraryAsync
}))
vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string
    constructor(...parts: string[]) {
      this.uri = parts.join('/')
    }
    get size(): number {
      return device.files.get(this.uri)?.byteLength ?? 0
    }
    create(): void {}
    write(): void {}
    delete(): void {
      device.deleted.push(this.uri)
      device.files.delete(this.uri)
    }
    open(): { offset: number | null; readBytes: () => Uint8Array; close: () => void } {
      return { offset: 0, readBytes: () => new Uint8Array(), close: () => {} }
    }
  },
  Paths: { cache: 'file:///cache' }
}))

import { useNativeDeviceVerbs } from './use-native-device-verbs'

type Serve = ReturnType<typeof useNativeDeviceVerbs>

function mount(
  sessionId: string | null,
  strict = false
): {
  serve: Serve
  replace: (sessionId: string) => void
  unmount: () => void
} {
  const held: { serve: Serve | null } = { serve: null }
  function Probe({ session }: { session: string | null }): ReactElement | null {
    held.serve = useNativeDeviceVerbs(session)
    return null
  }
  const render = (session: string | null): ReactElement =>
    strict ? (
      <StrictMode>
        <Probe session={session} />
      </StrictMode>
    ) : (
      <Probe session={session} />
    )
  let tree: ReturnType<typeof create> | null = null
  act(() => {
    tree = create(render(sessionId))
  })
  const serve: Serve = (verb, params) => {
    if (held.serve === null) {
      throw new Error('the probe rendered without a handler')
    }
    return held.serve(verb, params)
  }
  return {
    serve,
    replace: (sessionId) => {
      act(() => {
        tree?.update(render(sessionId))
      })
    },
    unmount: () => {
      act(() => {
        tree?.unmount()
      })
    }
  }
}

describe('the device handler the shell hands its host', () => {
  it('sends a clipboard verb to the clipboard half', async () => {
    const { serve, unmount } = mount('session-a')
    await expect(serve('native.clipboard.read', { mime: 'text' })).resolves.toEqual({
      value: 'on the pasteboard'
    })
    unmount()
  })

  it('sends a media verb to the media half, picker and all', async () => {
    const { serve, unmount } = mount('session-a')
    await expect(
      serve('native.media.pick', { source: 'library', multiple: false })
    ).resolves.toEqual({ items: [] })
    expect(device.picker.launchImageLibraryAsync).toHaveBeenCalled()
    unmount()
  })

  it('answers a release for a handle no pick ever minted, rather than refusing', async () => {
    const { serve, unmount } = mount('session-a')
    await expect(serve('native.media.release', { handle: 'media-9' })).resolves.toEqual({
      released: false
    })
    unmount()
  })
})

describe('a picker completing after its page session ends', () => {
  beforeEach(() => {
    device.files.clear()
    device.deleted.length = 0
  })

  const cases = (['unmount', 'replace'] as const).flatMap((ending) =>
    (['library', 'files'] as const).flatMap((source) =>
      [false, true].map((strict) => ({ ending, source, strict }))
    )
  )
  it.each(cases)(
    'discards late $source files after $ending and preserves a successor, StrictMode=$strict',
    async ({ ending, source, strict }) => {
      let answer: (result: PickerResult) => void = () => {
        throw new Error('the picker has not opened')
      }
      const pending = new Promise<PickerResult>((resolve) => {
        answer = resolve
      })
      const picker =
        source === 'library'
          ? device.picker.launchImageLibraryAsync
          : device.picker.getDocumentAsync
      picker.mockReturnValueOnce(pending)
      const first = mount('session-a', strict)
      const picked = first.serve('native.media.pick', { source, multiple: true })
      expect(picker).toHaveBeenCalled()
      if (ending === 'unmount') {
        first.unmount()
      } else {
        first.replace('session-b')
      }
      const successor = ending === 'unmount' ? mount('session-b', strict) : first
      const liveUri = 'file:///cache/successor.png'
      device.files.set(liveUri, new Uint8Array(4096))
      picker.mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: liveUri, mimeType: 'image/png' }]
      })
      const live = await successor.serve('native.media.pick', { source, multiple: false })
      expect(live).toMatchObject({ items: [{ byteLength: 4096 }] })
      const lateUris = ['file:///cache/late-1.png', 'file:///cache/late-2.png']
      for (const uri of lateUris) {
        device.files.set(uri, new Uint8Array(1024 * 1024))
      }
      answer({
        canceled: false,
        assets: lateUris.map((uri) => ({ uri, mimeType: 'image/png' }))
      })
      await expect(picked).resolves.toEqual({ items: [] })
      expect(device.deleted).toEqual(lateUris)
      expect([...device.files.keys()]).toEqual([liveUri])
      expect(device.files.get(liveUri)?.byteLength).toBe(4096)
      successor.unmount()
      expect(device.deleted).toEqual([...lateUris, liveUri])
      expect(device.files.size).toBe(0)
    }
  )
})

describe('the screen a page session leaves behind', () => {
  beforeEach(() => {
    device.wakeTags.length = 0
  })

  it('is given back when the session ends with the microphone still open', async () => {
    const first = mount('session-a')
    await first.serve('native.audio.start', { sampleRate: 16_000 })
    await Promise.resolve()
    expect(device.wakeTags).toEqual(['+orca-microphone'])
    // Page-session cleanup must release a mic’s wake lock even if the document disappears mid-dictation.
    first.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(device.wakeTags).toEqual(['+orca-microphone', '-orca-microphone'])
  })

  it('leaves the next session nothing of the last one to give back', async () => {
    const first = mount('session-a')
    await first.serve('native.audio.start', { sampleRate: 16_000 })
    first.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    device.wakeTags.length = 0
    const second = mount('session-b')
    second.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A session with no capture must not deactivate an unheld wake tag.
    expect(device.wakeTags).toEqual([])
  })
})
