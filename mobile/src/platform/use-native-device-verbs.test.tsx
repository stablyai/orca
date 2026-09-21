/** The one handler the host dispatches to: which verb reaches which device half, and for how long. */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({
  clipboard: { getStringAsync: vi.fn(() => Promise.resolve('on the pasteboard')) },
  picker: { launchImageLibraryAsync: vi.fn(() => Promise.resolve({ canceled: true })) },
  deleted: new Array<string>(),
  /** Every wake-tag call the device saw, as `+tag` and `-tag`, so an unreleased tag is visible. */
  wakeTags: new Array<string>()
}))

vi.mock('expo-clipboard', () => ({
  setStringAsync: () => Promise.resolve(true),
  getStringAsync: device.clipboard.getStringAsync,
  getImageAsync: () => Promise.resolve(null)
}))
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: () => Promise.resolve({ canceled: true })
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
    readonly size = 0
    constructor(...parts: string[]) {
      this.uri = parts.join('/')
    }
    create(): void {}
    write(): void {}
    delete(): void {
      device.deleted.push(this.uri)
    }
    open(): { offset: number | null; readBytes: () => Uint8Array; close: () => void } {
      return { offset: 0, readBytes: () => new Uint8Array(), close: () => {} }
    }
  },
  Paths: { cache: 'file:///cache' }
}))

import { useNativeDeviceVerbs } from './use-native-device-verbs'

type Serve = ReturnType<typeof useNativeDeviceVerbs>

function mount(sessionId: string | null): { serve: Serve; unmount: () => void } {
  const held: { serve: Serve | null } = { serve: null }
  function Probe({ session }: { session: string | null }): ReactElement | null {
    held.serve = useNativeDeviceVerbs(session)
    return null
  }
  let tree: ReturnType<typeof create> | null = null
  act(() => {
    tree = create(<Probe session={sessionId} />)
  })
  const serve: Serve = (verb, params) => {
    if (held.serve === null) {
      throw new Error('the probe rendered without a handler')
    }
    return held.serve(verb, params)
  }
  return {
    serve,
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

describe('the wake tag a page session takes', () => {
  beforeEach(() => {
    device.wakeTags.length = 0
  })

  it('is given back when the session ends, not left holding the screen awake', async () => {
    const first = mount('session-a')
    await expect(
      first.serve('native.wakelock.set', { active: true, tag: 'orca-a' })
    ).resolves.toEqual({ active: true })
    // The page is a document that can navigate, fault or be swiped away mid-dictation, so a tag it
    // took and never released would keep the screen awake for the app's lifetime.
    first.unmount()
    await Promise.resolve()
    expect(device.wakeTags).toEqual(['+orca-a', '-orca-a'])
  })

  it('leaves the next session nothing of the last one to release', async () => {
    const first = mount('session-a')
    await first.serve('native.wakelock.set', { active: true, tag: 'orca-a' })
    first.unmount()
    await Promise.resolve()
    device.wakeTags.length = 0
    const second = mount('session-b')
    // A tag the previous session held is the previous session's; this one asking for it back must
    // not reach the device, and must not report it as held either.
    await expect(
      second.serve('native.wakelock.set', { active: false, tag: 'orca-a' })
    ).resolves.toEqual({ active: false })
    expect(device.wakeTags).toEqual([])
    second.unmount()
  })
})
