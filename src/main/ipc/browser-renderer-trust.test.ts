import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isTrustedUIRenderer } = vi.hoisted(() => ({ isTrustedUIRenderer: vi.fn() }))

vi.mock('./ui', () => ({ isTrustedUIRenderer }))

import { isTrustedBrowserRenderer } from './browser-renderer-trust'

describe('browser renderer trust', () => {
  beforeEach(() => {
    isTrustedUIRenderer.mockReset()
  })

  it('uses the Orca UI trust predicate for every sender', () => {
    const makeSender = (id: number, type = 'window') => ({
      id,
      getType: () => type,
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false
    })
    const orca = makeSender(1)
    const dashboard = makeSender(2)
    const webview = makeSender(3, 'webview')
    isTrustedUIRenderer.mockImplementation((sender) => sender === orca)

    expect(isTrustedBrowserRenderer(orca as never)).toBe(true)
    expect(isTrustedBrowserRenderer(dashboard as never)).toBe(false)
    expect(isTrustedBrowserRenderer(webview as never)).toBe(false)
    expect(isTrustedUIRenderer.mock.calls.map(([sender]) => sender)).toEqual([
      orca,
      dashboard,
      webview
    ])
  })
})
