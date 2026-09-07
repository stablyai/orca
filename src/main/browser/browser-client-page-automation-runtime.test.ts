import { describe, expect, it, vi } from 'vitest'
import { BrowserClientPageAutomationRuntime } from './browser-client-page-automation-runtime'

describe('BrowserClientPageAutomationRuntime', () => {
  it('lazily registers the exact retained guest and forces its page selector', async () => {
    const fixture = createFixture()

    await expect(
      fixture.runtime.execute(
        input({ params: { page: 'remote-page', worktree: 'remote-workspace', x: 10 } }),
        new AbortController().signal
      )
    ).resolves.toEqual({ clicked: true })

    expect(fixture.registerGuest).toHaveBeenCalledWith({
      browserPageId: 'page-a',
      workspaceId: '',
      worktreeId: '',
      sessionProfileId: 'profile-a',
      webContentsId: 42,
      rendererWebContentsId: 7
    })
    expect(fixture.executeRpc).toHaveBeenCalledWith(
      'browser.click',
      { x: 10, page: 'page-a' },
      expect.any(AbortSignal)
    )

    await fixture.runtime.execute(input(), new AbortController().signal)
    expect(fixture.registerGuest).toHaveBeenCalledOnce()
  })

  it('rejects stale page generations and WebContents before dispatch', async () => {
    const fixture = createFixture()
    await fixture.runtime.execute(input(), new AbortController().signal)
    fixture.executeRpc.mockClear()

    await expect(
      fixture.runtime.execute(input({ pageHostGeneration: 10 }), new AbortController().signal)
    ).rejects.toThrow('browser_client_page_automation_registration_stale')
    await expect(
      fixture.runtime.execute(
        input({ registration: { ...registration, webContentsId: 43 } }),
        new AbortController().signal
      )
    ).rejects.toThrow('browser_client_page_automation_registration_stale')
    expect(fixture.executeRpc).not.toHaveBeenCalled()
  })

  it('retires only the exact registered generation and WebContents', async () => {
    const fixture = createFixture()
    await fixture.runtime.execute(input(), new AbortController().signal)

    await fixture.runtime.retire({
      browserPageId: 'page-a',
      pageHostGeneration: 10,
      registration
    })
    expect(fixture.onTabClosed).not.toHaveBeenCalled()
    expect(fixture.unregisterGuest).not.toHaveBeenCalled()

    await fixture.runtime.retire({
      browserPageId: 'page-a',
      pageHostGeneration: 9,
      registration
    })
    expect(fixture.onTabClosed).toHaveBeenCalledWith(42)
    expect(fixture.unregisterGuest).toHaveBeenCalledWith('page-a')
  })

  it('rejects aborts and registration failures before RPC dispatch', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    controller.abort()

    await expect(fixture.runtime.execute(input(), controller.signal)).rejects.toThrow(
      'browser_client_page_command_aborted'
    )
    expect(fixture.registerGuest).not.toHaveBeenCalled()

    fixture.registerGuest.mockReturnValue(false)
    await expect(fixture.runtime.execute(input(), new AbortController().signal)).rejects.toThrow(
      'browser_client_page_automation_registration_failed'
    )
    expect(fixture.executeRpc).not.toHaveBeenCalled()
  })
})

const registration = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 9,
  rendererWebContentsId: 7,
  webContentsId: 42
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    browserPageId: 'page-a',
    pageHostGeneration: 9,
    browserProfileId: 'profile-a',
    method: 'browser.click' as const,
    params: { x: 10 },
    registration,
    ...overrides
  }
}

function createFixture() {
  let registeredWebContentsId: number | null = null
  const getGuestWebContentsId = vi.fn(() => registeredWebContentsId)
  const registerGuest = vi.fn((registered: { webContentsId: number }) => {
    registeredWebContentsId = registered.webContentsId
    return true
  })
  const unregisterGuest = vi.fn(() => {
    registeredWebContentsId = null
  })
  const onTabClosed = vi.fn(async () => {})
  const executeRpc = vi.fn(async () => ({ clicked: true }))
  return {
    runtime: new BrowserClientPageAutomationRuntime({
      browserManager: { getGuestWebContentsId, registerGuest, unregisterGuest },
      getAgentBrowserBridge: () => ({ onTabClosed }),
      executeRpc
    }),
    registerGuest,
    unregisterGuest,
    onTabClosed,
    executeRpc
  }
}
