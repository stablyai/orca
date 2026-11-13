import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardImage, ClipboardReader } from './clipboard'

const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(() => Promise.resolve(true)),
  getStringAsync: vi.fn(() => Promise.resolve('')),
  getImageAsync: vi.fn<() => Promise<ClipboardImage | null>>(() => Promise.resolve(null)),
  hasStringAsync: vi.fn(() => Promise.resolve(false)),
  hasImageAsync: vi.fn(() => Promise.resolve(false))
}))

vi.mock('expo-clipboard', () => clipboard)

import { useClipboardReader } from './clipboard'

function mountReader(): ClipboardReader {
  const held: { reader: ClipboardReader | null } = { reader: null }
  function Screen(): null {
    held.reader = useClipboardReader()
    return null
  }
  act(() => {
    create(<Screen />)
  })
  const reader = held.reader
  if (reader === null) {
    throw new Error('nothing mounted')
  }
  return reader
}

beforeEach(() => {
  clipboard.setStringAsync.mockReset()
  clipboard.setStringAsync.mockImplementation(() => Promise.resolve(true))
  clipboard.getStringAsync.mockReset()
  clipboard.getStringAsync.mockImplementation(() => Promise.resolve(''))
  clipboard.getImageAsync.mockReset()
  clipboard.getImageAsync.mockImplementation(() => Promise.resolve(null))
  clipboard.hasStringAsync.mockReset()
  clipboard.hasStringAsync.mockImplementation(() => Promise.resolve(false))
  clipboard.hasImageAsync.mockReset()
  clipboard.hasImageAsync.mockImplementation(() => Promise.resolve(false))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reading the clipboard on a phone', () => {
  it('starts both probes before either has answered', async () => {
    // Hold both probes open to prove they start in parallel; sequential awaits add IPC latency on mount/foreground/toggle.
    const started: string[] = []
    let releaseString = (): void => {}
    clipboard.hasStringAsync.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          started.push('string')
          releaseString = () => resolve(true)
        })
    )
    clipboard.hasImageAsync.mockImplementation(() => {
      started.push('image')
      releaseString()
      return Promise.resolve(false)
    })
    await expect(mountReader().contents()).resolves.toEqual({ text: true, image: false })
    expect(started).toEqual(['string', 'image'])
  })

  it('reads a probe that threw as absent, rather than disabling paste on a rejection', async () => {
    clipboard.hasStringAsync.mockImplementation(() => Promise.reject(new Error('no pasteboard')))
    await expect(mountReader().contents()).resolves.toEqual({ text: false, image: false })
  })
})
