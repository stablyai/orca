import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardImage, ClipboardReader, ClipboardWriter } from './clipboard'

const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(() => Promise.resolve(true)),
  getStringAsync: vi.fn(() => Promise.resolve('')),
  getImageAsync: vi.fn<() => Promise<ClipboardImage | null>>(() => Promise.resolve(null)),
  hasStringAsync: vi.fn(() => Promise.resolve(false)),
  hasImageAsync: vi.fn(() => Promise.resolve(false))
}))

vi.mock('expo-clipboard', () => clipboard)

import { useClipboardReader, useClipboardWriter } from './clipboard'

function mountWriter(): ClipboardWriter {
  const held: { writer: ClipboardWriter | null } = { writer: null }
  function Screen(): null {
    held.writer = useClipboardWriter()
    return null
  }
  act(() => {
    create(<Screen />)
  })
  const writer = held.writer
  if (writer === null) {
    throw new Error('nothing mounted')
  }
  return writer
}

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

describe('writing the clipboard on a phone', () => {
  it('hands the text to the app unchanged', async () => {
    const writer = mountWriter()
    await expect(writer.writeText('copied')).resolves.toBeUndefined()
    expect(clipboard.setStringAsync.mock.calls).toEqual([['copied']])
  })

  it('propagates a pasteboard write failure', async () => {
    clipboard.setStringAsync.mockRejectedValue(new Error('Clipboard unavailable'))
    const writer = mountWriter()
    await expect(writer.writeText('copied')).rejects.toThrow('Clipboard unavailable')
  })
})

describe('reading the clipboard on a phone', () => {
  it('hands back the text the app has', async () => {
    clipboard.getStringAsync.mockImplementation(() => Promise.resolve('pasted'))
    await expect(mountReader().readText()).resolves.toBe('pasted')
  })

  it('asks for PNG and returns the image and its dimensions', async () => {
    clipboard.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,AQID',
      size: { width: 3, height: 1 }
    })
    await expect(mountReader().readImage()).resolves.toEqual({
      data: 'data:image/png;base64,AQID',
      size: { width: 3, height: 1 }
    })
    expect(clipboard.getImageAsync.mock.calls).toEqual([[{ format: 'png' }]])
  })

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

  it('probes both kinds without reading either', async () => {
    clipboard.hasImageAsync.mockImplementation(() => Promise.resolve(true))
    await expect(mountReader().contents()).resolves.toEqual({ text: false, image: true })
    // Probe without reading so iOS does not show paste consent just to enable a button.
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getImageAsync).not.toHaveBeenCalled()
  })

  it('reads a probe that threw as absent, rather than disabling paste on a rejection', async () => {
    clipboard.hasStringAsync.mockImplementation(() => Promise.reject(new Error('no pasteboard')))
    await expect(mountReader().contents()).resolves.toEqual({ text: false, image: false })
  })
})
