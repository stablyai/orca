import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('browser RPC methods', () => {
  it('routes core browser automation commands to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserSnapshot: vi.fn().mockResolvedValue({ elements: [] }),
      browserGoto: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
      browserProfileDetectBrowsers: vi.fn().mockResolvedValue({ browsers: [] }),
      browserProfileImportFromBrowser: vi.fn().mockResolvedValue({ ok: false, reason: 'empty' }),
      browserTabCreate: vi.fn().mockResolvedValue({ browserPageId: 'page-1' }),
      browserTabSwitch: vi.fn().mockResolvedValue({ browserPageId: 'page-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })

    await dispatcher.dispatch(makeRequest('browser.snapshot', { worktree: 'id:wt-1' }))
    await dispatcher.dispatch(
      makeRequest('browser.goto', {
        worktree: 'id:wt-1',
        page: 'page-1',
        url: 'https://example.com'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browser.tabCreate', {
        worktree: 'id:wt-1',
        url: 'https://example.com',
        profileId: 'profile-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browser.tabSwitch', {
        worktree: 'id:wt-1',
        index: 0,
        focus: true
      })
    )
    await dispatcher.dispatch(makeRequest('browser.profileDetectBrowsers'))
    await dispatcher.dispatch(
      makeRequest('browser.profileImportFromBrowser', {
        profileId: 'profile-1',
        browserFamily: 'chrome',
        browserProfile: 'Default'
      })
    )

    expect(runtime.browserSnapshot).toHaveBeenCalledWith({ worktree: 'id:wt-1' })
    expect(runtime.browserGoto).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      url: 'https://example.com'
    })
    expect(runtime.browserTabCreate).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      url: 'https://example.com',
      profileId: 'profile-1'
    })
    expect(runtime.browserTabSwitch).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      index: 0,
      focus: true
    })
    expect(runtime.browserProfileDetectBrowsers).toHaveBeenCalled()
    expect(runtime.browserProfileImportFromBrowser).toHaveBeenCalledWith({
      profileId: 'profile-1',
      browserFamily: 'chrome',
      browserProfile: 'Default'
    })
  })

  it('routes browser session and environment controls to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserCookieGet: vi.fn().mockResolvedValue({ cookies: [] }),
      browserSetViewport: vi.fn().mockResolvedValue({ ok: true }),
      browserMouseWheel: vi.fn().mockResolvedValue({ ok: true }),
      browserStorageLocalSet: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_EXTRA_METHODS })

    await dispatcher.dispatch(
      makeRequest('browser.cookie.get', {
        worktree: 'id:wt-1',
        page: 'page-1',
        url: 'https://example.com'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browser.viewport', {
        worktree: 'id:wt-1',
        page: 'page-1',
        width: 1024,
        height: 768
      })
    )
    await dispatcher.dispatch(
      makeRequest('browser.mouseWheel', {
        worktree: 'id:wt-1',
        page: 'page-1',
        dy: 240
      })
    )
    await dispatcher.dispatch(
      makeRequest('browser.storage.local.set', {
        worktree: 'id:wt-1',
        page: 'page-1',
        key: 'orca',
        value: 'enabled'
      })
    )

    expect(runtime.browserCookieGet).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      url: 'https://example.com'
    })
    expect(runtime.browserSetViewport).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      width: 1024,
      height: 768
    })
    expect(runtime.browserMouseWheel).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      dy: 240
    })
    expect(runtime.browserStorageLocalSet).toHaveBeenCalledWith({
      worktree: 'id:wt-1',
      page: 'page-1',
      key: 'orca',
      value: 'enabled'
    })
  })
})
