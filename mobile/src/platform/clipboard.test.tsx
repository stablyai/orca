/** The native form of the clipboard seam: the app's own `expo-clipboard`, and what it answers. */
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardWriter } from './clipboard'

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(() => Promise.resolve(true)) }))

vi.mock('expo-clipboard', () => clipboard)

import { useClipboardWriter } from './clipboard'

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

beforeEach(() => {
  clipboard.setStringAsync.mockReset()
  clipboard.setStringAsync.mockImplementation(() => Promise.resolve(true))
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
