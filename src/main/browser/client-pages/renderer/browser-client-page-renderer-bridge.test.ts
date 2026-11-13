import { describe, expect, it, vi } from 'vitest'
import {
  completeRendererMount as completeMount,
  createRendererBridgeTestRig as createHarness,
  createRendererEndpoint as createEndpoint,
  rendererPage as page,
  sentRendererRequest as sentRequest
} from './browser-client-page-renderer-bridge-test-rig'

describe('BrowserClientPageRendererBridgeRegistry', () => {
  it('mounts only through the exact current main-frame document and carries no target URL', async () => {
    const harness = createHarness()
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const mounted = renderer.mountPage(page, new AbortController().signal)
    const request = sentRequest(harness.endpoint)

    expect(harness.endpoint.send).toHaveBeenCalledWith(
      'browser:clientPageRendererRequest',
      expect.objectContaining({ type: 'mountPage', page })
    )
    expect(sentRequest(harness.endpoint)).not.toHaveProperty('url')

    harness.reply(createEndpoint(41), {
      type: 'mounted',
      requestId: request.requestId,
      page: request.page,
      webContentsId: 90
    })
    completeMount(harness, harness.endpoint, 90, {})
    await expect(Promise.race([mounted, Promise.resolve('pending')])).resolves.toBe('pending')

    const staleFrame = harness.endpoint.mainFrame
    harness.endpoint.mainFrame = {}
    completeMount(harness, harness.endpoint, 90, staleFrame)
    await expect(mounted).rejects.toThrow('browser_client_page_renderer_stale')

    const replacement = harness.registry.attachRenderer(harness.endpoint)
    const current = replacement.mountPage(page, new AbortController().signal)
    completeMount(harness)
    await expect(current).resolves.toEqual({ webContentsId: 91 })
  })

  it('retains an admitted canceled mount until its exact guest identity arrives', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const abort = new AbortController()
    const mounted = renderer.mountPage(page, abort.signal)
    const staleRequest = sentRequest(harness.endpoint)

    abort.abort()
    await expect(Promise.race([mounted, Promise.resolve('pending')])).resolves.toBe('pending')
    await expect(renderer.retirePage(page)).rejects.toThrow(
      'browser_client_page_renderer_request_capacity'
    )
    harness.reply(harness.endpoint, {
      type: 'mounted',
      requestId: staleRequest.requestId,
      page,
      webContentsId: 92
    })
    await expect(mounted).resolves.toEqual({ webContentsId: 92 })

    const current = renderer.mountPage(
      { ...page, pageHostGeneration: 8 },
      new AbortController().signal
    )
    harness.reply(harness.endpoint, {
      type: 'mounted',
      requestId: staleRequest.requestId,
      page,
      webContentsId: 92
    })
    await expect(Promise.race([current, Promise.resolve('pending')])).resolves.toBe('pending')
    completeMount(harness)
    await expect(current).resolves.toEqual({ webContentsId: 91 })
  })

  it('times out a canceled mount and fences its late reply from a successor', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ maxPending: 1, timeoutMs: 25 })
    try {
      const renderer = harness.registry.attachRenderer(harness.endpoint)
      const abort = new AbortController()
      const timedOut = renderer.mountPage(page, abort.signal)
      const staleRequest = sentRequest(harness.endpoint)
      const timedOutResult = timedOut.catch((error: unknown) => error)

      abort.abort()
      await vi.advanceTimersByTimeAsync(24)
      const blocked = Promise.resolve(renderer.retirePage(page)).catch((error: unknown) => error)
      expect(harness.endpoint.send).toHaveBeenCalledTimes(1)
      await expect(blocked).resolves.toHaveProperty(
        'message',
        'browser_client_page_renderer_request_capacity'
      )
      await vi.advanceTimersByTimeAsync(1)
      await expect(timedOutResult).resolves.toHaveProperty(
        'message',
        'browser_client_page_renderer_request_timeout'
      )

      const successor = renderer.mountPage(
        { ...page, pageHostGeneration: 8 },
        new AbortController().signal
      )
      harness.reply(harness.endpoint, {
        type: 'mounted',
        requestId: staleRequest.requestId,
        page,
        webContentsId: 92
      })
      await expect(Promise.race([successor, Promise.resolve('pending')])).resolves.toBe('pending')
      completeMount(harness, harness.endpoint, 93)
      await expect(successor).resolves.toEqual({ webContentsId: 93 })
    } finally {
      harness.registry.dispose()
      vi.useRealTimers()
    }
  })
})
