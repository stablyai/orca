import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatQueuedEditFocus } from './use-mobile-native-chat-queued-edit-focus'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'

type Focus = ReturnType<typeof useMobileNativeChatQueuedEditFocus>

describe('useMobileNativeChatQueuedEditFocus', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: Focus | null = null

  function Harness({ onEdit }: { onEdit?: MobileQueuedMessageEdit }): null {
    latest = useMobileNativeChatQueuedEditFocus(onEdit)
    return null
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
    vi.unstubAllGlobals()
  })

  it('focuses the composer after Edit copies a queued message into it', async () => {
    const onEdit = vi.fn<MobileQueuedMessageEdit>(async (_messageId, onCopied) => {
      onCopied?.()
      return false
    })
    await act(async () => {
      renderer = create(createElement(Harness, { onEdit }))
    })
    const focus = vi.fn()
    const inputRef: { current: unknown } = latest!.composerInputRef
    inputRef.current = { focus }
    let edited: boolean | undefined
    await act(async () => {
      edited = await latest!.editQueuedMessage!('queued-1')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onEdit).toHaveBeenCalledWith('queued-1', expect.any(Function))
    // A failed Delete still leaves the copied text in the composer, so focus regardless.
    expect(focus).toHaveBeenCalledTimes(1)
    expect(edited).toBe(false)
  })

  it('leaves focus alone when Edit copied nothing', async () => {
    const onEdit = vi.fn<MobileQueuedMessageEdit>(async () => false)
    await act(async () => {
      renderer = create(createElement(Harness, { onEdit }))
    })
    const focus = vi.fn()
    const inputRef: { current: unknown } = latest!.composerInputRef
    inputRef.current = { focus }
    await act(async () => {
      await latest!.editQueuedMessage!('queued-1')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(focus).not.toHaveBeenCalled()
  })

  it('passes no Edit through when the cards offer none', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, {}))
    })
    expect(latest!.editQueuedMessage).toBeUndefined()
  })
})
