import { beforeEach, describe, expect, it, vi } from 'vitest'

const { start, stop, initialize, clear } = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  initialize: vi.fn(),
  clear: vi.fn()
}))
vi.mock('./external-chromium-browser-session', () => ({
  ExternalChromiumBrowserSession: class {
    start = start
    stop = stop
  }
}))
vi.mock('./external-chromium-tab-registry', () => ({
  ExternalChromiumTabRegistry: class {
    initialize = initialize
    clear = clear
  }
}))

import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'

describe('external Chromium startup cancellation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('does not publish a session that resolves after cancellation and permits cleanup', async () => {
    const controller = new AbortController()
    start.mockImplementation(async () => {
      controller.abort()
      return 'tab-live'
    })
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/orca/agent-browser',
      { executablePath: '/opt/orca/chromium', provider: 'chromium' },
      '/state'
    )
    await expect(browser.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledWith(controller.signal)
    expect(initialize).not.toHaveBeenCalled()
    expect(browser.isAvailable()).toBe(false)
    await browser.stop()
    expect(stop).toHaveBeenCalledWith()
    expect(clear).toHaveBeenCalledOnce()
  })
})
