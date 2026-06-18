import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../../../shared/clipboard-text'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser-screencast'
import { ClipboardWrite, Fill, KeyboardInsert, Type } from './browser-schemas'

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

  it('routes browser screencast over the streaming dispatcher', async () => {
    const sendBinary = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserScreencast: vi.fn(
        async (_params: unknown, options: { emit: (result: unknown) => void }) => {
          options.emit({ type: 'end', subscriptionId: 'browser-screencast:page-1:test' })
        }
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_SCREENCAST_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('browser.screencast', {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        quality: 80,
        maxWidth: 1024,
        viewportWidth: 900,
        viewportHeight: 600
      }),
      (reply) => replies.push(reply),
      { connectionId: 'conn-1', sendBinary }
    )

    expect(runtime.browserScreencast).toHaveBeenCalledWith(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        quality: 80,
        maxWidth: 1024,
        viewportWidth: 900,
        viewportHeight: 600
      },
      {
        connectionId: 'conn-1',
        sendBinary,
        signal: undefined,
        emit: expect.any(Function)
      }
    )
    expect(JSON.parse(replies[0])).toMatchObject({
      ok: true,
      streaming: true,
      result: { type: 'end', subscriptionId: 'browser-screencast:page-1:test' }
    })
  })

  it('routes browser screencast unsubscribe to runtime cleanup', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_SCREENCAST_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('browser.screencast.unsubscribe', {
        subscriptionId: 'browser-screencast:page-1:test'
      })
    )

    expect(runtime.cleanupSubscription).toHaveBeenCalledWith('browser-screencast:page-1:test')
    expect(response).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
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

  it('rejects non-boolean browser check states instead of coercing them to true', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserCheck: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('browser.check', {
        page: 'page-1',
        element: 'ref-1',
        checked: 'false'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runtime.browserCheck).not.toHaveBeenCalled()
  })

  it('rejects oversized browser clipboard writes before runtime dispatch', async () => {
    const secret = 'browser-secret-token'
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserClipboardWrite: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_EXTRA_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('browser.clipboardWrite', {
        page: 'page-1',
        text: secret + 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
      }
    })
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(runtime.browserClipboardWrite).not.toHaveBeenCalled()
  })

  it('leaves browser text byte limits to async handlers', () => {
    const text = 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)

    expect(Fill.safeParse({ element: '@e1', value: text }).success).toBe(true)
    expect(Type.safeParse({ input: text }).success).toBe(true)
    expect(KeyboardInsert.safeParse({ text }).success).toBe(true)
    expect(ClipboardWrite.safeParse({ text }).success).toBe(true)
  })

  it('yields while validating large accepted browser text insertion before dispatch', async () => {
    vi.useFakeTimers()
    try {
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        browserType: vi.fn().mockResolvedValue({ typed: true })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })

      const responsePromise = dispatcher.dispatch(makeRequest('browser.type', { input: text }))
      await Promise.resolve()

      expect(runtime.browserType).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()
      const response = await responsePromise

      expect(response).toMatchObject({
        ok: true,
        result: { typed: true }
      })
      expect(runtime.browserType).toHaveBeenCalledWith({ input: text })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized browser text insertion before runtime dispatch', async () => {
    const secret = 'browser-insert-secret'
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserFill: vi.fn().mockResolvedValue({ filled: '@e1' }),
      browserType: vi.fn().mockResolvedValue({ typed: true }),
      browserKeyboardInsertText: vi.fn().mockResolvedValue({ inserted: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })
    const text = [secret, 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)].join('')

    const fillResponse = await dispatcher.dispatch(
      makeRequest('browser.fill', { element: '@e1', value: text })
    )
    const typeResponse = await dispatcher.dispatch(makeRequest('browser.type', { input: text }))
    const keyboardInsertResponse = await dispatcher.dispatch(
      makeRequest('browser.keyboardInsertText', { text })
    )

    expect(fillResponse).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
      }
    })
    expect(typeResponse).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
      }
    })
    expect(keyboardInsertResponse).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
      }
    })
    expect(JSON.stringify([fillResponse, typeResponse, keyboardInsertResponse])).not.toContain(
      secret
    )
    expect(runtime.browserFill).not.toHaveBeenCalled()
    expect(runtime.browserType).not.toHaveBeenCalled()
    expect(runtime.browserKeyboardInsertText).not.toHaveBeenCalled()
  })
})
