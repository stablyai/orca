/** The native form of the clipboard seam: the app's own `expo-clipboard`, and what it answers. */
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardReader, ClipboardWriter } from './clipboard'

const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(() => Promise.resolve(true)),
  getStringAsync: vi.fn(() => Promise.resolve('')),
  getImageAsync: vi.fn(() => Promise.resolve(null)),
  hasStringAsync: vi.fn(() => Promise.resolve(false)),
  hasImageAsync: vi.fn(() => Promise.resolve(false))
}))

vi.mock('expo-clipboard', () => clipboard)

import { useClipboardReader, useClipboardWriter } from './clipboard'

/** The hook as a screen holds it; `react-test-renderer` is what every other seam test here uses. */
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

/** The reader as a screen holds it, mounted the same way. */
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

  it('rejects when the pasteboard refused it, rather than reporting a copy', async () => {
    // `setStringAsync` answers whether the write landed, and a caller showing "Copied" over a
    // write that did not is the failure this seam exists to avoid.
    clipboard.setStringAsync.mockImplementation(() => Promise.resolve(false))
    const writer = mountWriter()
    await expect(writer.writeText('copied')).rejects.toThrow(/did not accept/)
  })
})

describe('reading the clipboard on a phone', () => {
  it('hands back the text the app has', async () => {
    clipboard.getStringAsync.mockImplementation(() => Promise.resolve('pasted'))
    await expect(mountReader().readText()).resolves.toBe('pasted')
  })

  it('asks for a PNG, which is the format the upload path re-encodes to', async () => {
    await expect(mountReader().readImage()).resolves.toBeNull()
    expect(clipboard.getImageAsync.mock.calls).toEqual([[{ format: 'png' }]])
  })

  it('starts both probes before either has answered', async () => {
    // Awaiting them in turn puts an IPC round trip on the critical path of every mount, every
    // foreground and every select-mode toggle, which is where these callers run. The order is the
    // subject, so neither probe resolves until both have been called.
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
      // The image probe answers first: with a sequential await this line is never reached, because
      // nothing would have called it before the text probe settled.
      releaseString()
      return Promise.resolve(false)
    })
    await expect(mountReader().contents()).resolves.toEqual({ text: true, image: false })
    expect(started).toEqual(['string', 'image'])
  })

  it('probes both kinds without reading either', async () => {
    clipboard.hasImageAsync.mockImplementation(() => Promise.resolve(true))
    await expect(mountReader().contents()).resolves.toEqual({ text: false, image: true })
    // The probe is the whole point on iOS: reading to find out raises the paste-consent prompt.
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getImageAsync).not.toHaveBeenCalled()
  })

  it('reads a probe that threw as absent, rather than disabling paste on a rejection', async () => {
    clipboard.hasStringAsync.mockImplementation(() => Promise.reject(new Error('no pasteboard')))
    await expect(mountReader().contents()).resolves.toEqual({ text: false, image: false })
  })
})
