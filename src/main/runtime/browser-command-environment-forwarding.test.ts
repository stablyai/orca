import { describe, expect, it, vi } from 'vitest'
import { BrowserError } from '../browser/cdp-bridge'
import type { RpcContext, RpcMethod } from './rpc/core'
import {
  forwardBrowserCommandToOwningEnvironment,
  isForwardableBrowserError,
  withBrowserEnvironmentForwarding
} from './browser-command-environment-forwarding'

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

const callRuntimeEnvironmentMock = vi.mocked(callRuntimeEnvironment)

describe('isForwardableBrowserError', () => {
  it('accepts target-miss codes carried on .code', () => {
    expect(isForwardableBrowserError(new BrowserError('browser_no_tab', 'no tab'))).toBe(true)
    expect(isForwardableBrowserError(new BrowserError('browser_tab_not_found', 'gone'))).toBe(true)
  })

  it('accepts plain runtime errors whose message is a forwardable code', () => {
    expect(isForwardableBrowserError(new Error('selector_not_found'))).toBe(true)
  })

  it('rejects non-forwardable errors', () => {
    expect(isForwardableBrowserError(new BrowserError('invalid_argument', 'bad'))).toBe(false)
    expect(isForwardableBrowserError(new Error('boom'))).toBe(false)
    expect(isForwardableBrowserError('browser_no_tab')).toBe(false)
    expect(isForwardableBrowserError(null)).toBe(false)
  })
})

describe('withBrowserEnvironmentForwarding', () => {
  const ctx = { runtime: {} } as unknown as RpcContext

  function makeMethod(handler: RpcMethod['handler']): RpcMethod {
    return { name: 'browser.snapshot', params: null, handler }
  }

  it('returns the local result without forwarding when the local call succeeds', async () => {
    const forward = vi.fn()
    const [wrapped] = withBrowserEnvironmentForwarding(
      [makeMethod(async () => ({ ok: true }))],
      forward
    )

    await expect(wrapped!.handler({}, ctx)).resolves.toEqual({ ok: true })
    expect(forward).not.toHaveBeenCalled()
  })

  it('forwards target-miss errors and returns the remote result', async () => {
    const forward = vi.fn().mockResolvedValue({ handled: true, result: { remote: true } })
    const [wrapped] = withBrowserEnvironmentForwarding(
      [
        makeMethod(async () => {
          throw new BrowserError('browser_no_tab', 'No browser session is active')
        })
      ],
      forward
    )

    await expect(wrapped!.handler({ page: 'p1' }, ctx)).resolves.toEqual({ remote: true })
    expect(forward).toHaveBeenCalledWith('browser.snapshot', { page: 'p1' }, 30_000, ctx)
  })

  it('rethrows the original error when no environment handles the forward', async () => {
    const localError = new BrowserError('browser_tab_not_found', 'gone')
    const forward = vi.fn().mockResolvedValue({ handled: false })
    const [wrapped] = withBrowserEnvironmentForwarding(
      [
        makeMethod(async () => {
          throw localError
        })
      ],
      forward
    )

    await expect(wrapped!.handler({}, ctx)).rejects.toBe(localError)
  })

  it('never forwards non-target-miss errors', async () => {
    const forward = vi.fn()
    const [wrapped] = withBrowserEnvironmentForwarding(
      [
        makeMethod(async () => {
          throw new BrowserError('invalid_argument', 'Missing element')
        })
      ],
      forward
    )

    await expect(wrapped!.handler({}, ctx)).rejects.toThrow('Missing element')
    expect(forward).not.toHaveBeenCalled()
  })

  it('extends the forward timeout for long-poll params', async () => {
    const forward = vi.fn().mockResolvedValue({ handled: true, result: null })
    const [wrapped] = withBrowserEnvironmentForwarding(
      [
        makeMethod(async () => {
          throw new Error('selector_not_found')
        })
      ],
      forward
    )

    await wrapped!.handler({ timeoutMs: 60_000 }, ctx)
    expect(forward).toHaveBeenCalledWith('browser.snapshot', { timeoutMs: 60_000 }, 70_000, ctx)
  })
})

describe('forwardBrowserCommandToOwningEnvironment', () => {
  it('is a no-op without an owning environment', async () => {
    await expect(
      forwardBrowserCommandToOwningEnvironment({
        environmentId: null,
        userDataPath: '/tmp/user-data',
        method: 'browser.snapshot',
        params: {},
        timeoutMs: 1_000
      })
    ).resolves.toEqual({ handled: false })
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('does not treat a focused-but-unrelated environment id as implicit ownership', async () => {
    await expect(
      forwardBrowserCommandToOwningEnvironment({
        environmentId: '   ',
        userDataPath: '/tmp/user-data',
        method: 'browser.snapshot',
        params: {},
        timeoutMs: 1_000
      })
    ).resolves.toEqual({ handled: false })
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('returns the remote result when the owning environment answers', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'browser.snapshot',
      ok: true,
      result: { snapshot: 'dom' },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      forwardBrowserCommandToOwningEnvironment({
        environmentId: ' env-1 ',
        userDataPath: '/tmp/user-data',
        method: 'browser.snapshot',
        params: { worktree: 'id:wt-1' },
        timeoutMs: 1_000
      })
    ).resolves.toEqual({ handled: true, result: { snapshot: 'dom' } })
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledWith(
      '/tmp/user-data',
      'env-1',
      'browser.snapshot',
      { worktree: 'id:wt-1' },
      1_000
    )
  })

  it('surfaces remote failures as BrowserError with the remote code', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'browser.snapshot',
      ok: false,
      error: { code: 'browser_no_tab', message: 'No browser session is active' },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      forwardBrowserCommandToOwningEnvironment({
        environmentId: 'env-1',
        userDataPath: '/tmp/user-data',
        method: 'browser.snapshot',
        params: {},
        timeoutMs: 1_000
      })
    ).rejects.toMatchObject({ code: 'browser_no_tab' })
  })
})
