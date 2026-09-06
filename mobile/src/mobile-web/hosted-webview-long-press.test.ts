import { describe, expect, it, vi } from 'vitest'
import { dispatchHostedWebViewLongPress } from '../../scripts/hosted-webview-long-press.mjs'

describe('hosted WebView long press', () => {
  it('holds the unchanged RNW control after native touch grants shell authority', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce('hosted-long-press-123')
      .mockResolvedValueOnce('hosted-long-press-123')
    const wait = vi.fn().mockResolvedValue(undefined)

    await dispatchHostedWebViewLongPress(
      { href: 'orca-mobile-web://build/session/workspace' },
      'Attach a photo',
      { evaluate, now: () => 123, wait }
    )

    expect(evaluate.mock.calls[0]?.[1]).toContain(
      "element.dispatchEvent(pointerEvent(element, 'mousedown', 1))"
    )
    expect(evaluate.mock.calls[0]?.[1]).toContain('document.getSelection()?.removeAllRanges()')
    expect(wait).toHaveBeenCalledWith(600)
    expect(evaluate.mock.calls[1]?.[1]).toContain("new MouseEvent('mouseup'")
  })

  it('fails closed when the hosted control cannot be located', async () => {
    await expect(
      dispatchHostedWebViewLongPress({}, 'Attach a photo', {
        evaluate: vi.fn().mockResolvedValue(''),
        now: () => 123,
        wait: vi.fn()
      })
    ).rejects.toThrow('Hosted WebView control was not found')
  })
})
