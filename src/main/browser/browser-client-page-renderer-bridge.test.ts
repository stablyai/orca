import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientPageRendererReply } from '../../shared/browser-client-page-renderer-protocol'
import {
  completeRendererMount as completeMount,
  createRendererBridgeTestRig as createHarness,
  createRendererEndpoint as createEndpoint,
  rendererPage as page,
  sentRendererRequest as sentRequest
} from './browser-client-page-renderer-bridge-test-rig'

describe('BrowserClientPageRendererBridgeRegistry', () => {
  it('rekeys only after an exact current-document echo', async () => {
    const harness = createHarness()
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const next = { ...page, pageHostGeneration: 8 }
    const rekeyed = renderer.rekeyPage!(page, next, new AbortController().signal)
    const request = sentRequest(harness.endpoint)

    expect(request).toMatchObject({ type: 'rekeyPage', page, nextPage: next })
    harness.reply(harness.endpoint, {
      type: 'rekeyed',
      requestId: request.requestId,
      page: request.page,
      nextPage: next
    })
    await expect(rekeyed).resolves.toBeUndefined()
  })

  it('accepts exact rekey failure and rejects a changed next-page echo', async () => {
    const harness = createHarness()
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const next = { ...page, pageHostGeneration: 8 }
    const failed = renderer.rekeyPage!(page, next, new AbortController().signal)
    let request = sentRequest(harness.endpoint)

    harness.reply(harness.endpoint, {
      type: 'failed',
      operation: 'rekeyPage',
      requestId: request.requestId,
      page: request.page,
      errorCode: 'browser_client_page_renderer_rekey_stale'
    })
    await expect(failed).rejects.toThrow('browser_client_page_renderer_rekey_stale')

    const mismatched = renderer.rekeyPage!(page, next, new AbortController().signal)
    request = sentRequest(harness.endpoint)
    harness.reply(harness.endpoint, {
      type: 'rekeyed',
      requestId: request.requestId,
      page: request.page,
      nextPage: { ...next, pageHostGeneration: 9 }
    })
    await expect(mismatched).rejects.toThrow('browser_client_page_renderer_reply_invalid')
  })

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

  it('rejects malformed matching replies and releases their admission', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const mounted = renderer.mountPage(page, new AbortController().signal)
    const request = sentRequest(harness.endpoint)

    harness.reply(harness.endpoint, { requestId: request.requestId, type: 'mounted' })
    await expect(mounted).rejects.toThrow('browser_client_page_renderer_reply_invalid')

    const replacement = renderer.mountPage(page, new AbortController().signal)
    completeMount(harness)
    await expect(replacement).resolves.toEqual({ webContentsId: 91 })
  })

  it('rejects well-formed replies for the wrong page or operation', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const wrongPage = renderer.mountPage(page, new AbortController().signal)
    let request = sentRequest(harness.endpoint)

    harness.reply(harness.endpoint, {
      type: 'mounted',
      requestId: request.requestId,
      page: { ...request.page, pageHostGeneration: request.page.pageHostGeneration + 1 },
      webContentsId: 91
    })
    await expect(wrongPage).rejects.toThrow('browser_client_page_renderer_reply_invalid')

    const wrongOperation = renderer.mountPage(page, new AbortController().signal)
    request = sentRequest(harness.endpoint)
    harness.reply(harness.endpoint, {
      type: 'failed',
      requestId: request.requestId,
      page: request.page,
      operation: 'retirePage',
      errorCode: 'renderer_failed'
    })
    await expect(wrongOperation).rejects.toThrow('browser_client_page_renderer_reply_invalid')
  })

  it('fences a pending generation when an exact renderer is replaced with a reused ID', async () => {
    const harness = createHarness()
    const first = harness.registry.attachRenderer(harness.endpoint)
    const pending = first.mountPage(page, new AbortController().signal)
    const staleRequest = sentRequest(harness.endpoint)
    const replacementEndpoint = createEndpoint(harness.endpoint.id)

    const replacement = harness.registry.attachRenderer(replacementEndpoint)
    await expect(pending).rejects.toThrow('browser_client_page_renderer_replaced')
    expect(first.isCurrent()).toBe(false)
    expect(replacement.isCurrent()).toBe(true)

    harness.reply(replacementEndpoint, {
      type: 'mounted',
      requestId: staleRequest.requestId,
      page,
      webContentsId: 92
    })
    const current = replacement.mountPage(page, new AbortController().signal)
    completeMount(harness, replacementEndpoint, 93)
    await expect(current).resolves.toEqual({ webContentsId: 93 })
  })

  it('aborts mount admission and ignores a late reply', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const abort = new AbortController()
    const mounted = renderer.mountPage(page, abort.signal)
    const staleRequest = sentRequest(harness.endpoint)

    abort.abort()
    await expect(mounted).rejects.toThrow('browser_client_page_renderer_request_aborted')
    harness.reply(harness.endpoint, {
      type: 'mounted',
      requestId: staleRequest.requestId,
      page,
      webContentsId: 92
    })

    const current = renderer.mountPage(page, new AbortController().signal)
    completeMount(harness)
    await expect(current).resolves.toEqual({ webContentsId: 91 })
  })

  it('retires only the exact renderer and rejects its pending work', async () => {
    const harness = createHarness()
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const mounted = renderer.mountPage(page, new AbortController().signal)
    const staleRequest = sentRequest(harness.endpoint)

    expect(harness.registry.retireRenderer(createEndpoint(harness.endpoint.id))).toBe(false)
    expect(renderer.isCurrent()).toBe(true)
    expect(harness.registry.retireRenderer(harness.endpoint)).toBe(true)

    await expect(mounted).rejects.toThrow('browser_client_page_renderer_retired')
    expect(renderer.isCurrent()).toBe(false)

    completeMount(harness)
    const replacement = harness.registry.attachRenderer(harness.endpoint)
    const current = replacement.mountPage(page, new AbortController().signal)
    expect(sentRequest(harness.endpoint).requestId).not.toBe(staleRequest.requestId)
    completeMount(harness)
    await expect(current).resolves.toEqual({ webContentsId: 91 })
  })

  it('bounds pending requests and settles retirement separately', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const mounted = renderer.mountPage(page, new AbortController().signal)

    await expect(renderer.retirePage(page)).rejects.toThrow(
      'browser_client_page_renderer_request_capacity'
    )
    completeMount(harness)
    await mounted

    const retired = renderer.retirePage(page)
    const request = sentRequest(harness.endpoint)
    expect(request.type).toBe('retirePage')
    harness.reply(harness.endpoint, {
      type: 'retired',
      requestId: request.requestId,
      page: request.page
    } satisfies BrowserClientPageRendererReply)
    await expect(retired).resolves.toBeUndefined()
  })

  it('times out exactly once and releases admission for later work', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ maxPending: 1, timeoutMs: 25 })
      const renderer = harness.registry.attachRenderer(harness.endpoint)
      const timedOut = renderer.mountPage(page, new AbortController().signal)
      const timedOutExpectation = expect(timedOut).rejects.toThrow(
        'browser_client_page_renderer_request_timeout'
      )

      await vi.advanceTimersByTimeAsync(25)
      await timedOutExpectation

      const replacement = renderer.mountPage(page, new AbortController().signal)
      completeMount(harness)
      await expect(replacement).resolves.toEqual({ webContentsId: 91 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a late rekey reply after timeout and admits an exact replacement', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ maxPending: 1, timeoutMs: 25 })
      const renderer = harness.registry.attachRenderer(harness.endpoint)
      const next = { ...page, pageHostGeneration: 8 }
      const timedOut = renderer.rekeyPage!(page, next, new AbortController().signal)
      const staleRequest = sentRequest(harness.endpoint)
      const timedOutExpectation = expect(timedOut).rejects.toThrow(
        'browser_client_page_renderer_request_timeout'
      )

      await vi.advanceTimersByTimeAsync(25)
      await timedOutExpectation
      harness.reply(harness.endpoint, {
        type: 'rekeyed',
        requestId: staleRequest.requestId,
        page: staleRequest.page,
        nextPage: next
      })

      const replacement = renderer.rekeyPage!(page, next, new AbortController().signal)
      const currentRequest = sentRequest(harness.endpoint)
      expect(currentRequest.requestId).not.toBe(staleRequest.requestId)
      harness.reply(harness.endpoint, {
        type: 'rekeyed',
        requestId: currentRequest.requestId,
        page: currentRequest.page,
        nextPage: next
      })
      await expect(replacement).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases admission when Electron send throws', async () => {
    const harness = createHarness({ maxPending: 1 })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    vi.mocked(harness.endpoint.send).mockImplementationOnce(() => {
      throw new Error('renderer unavailable')
    })

    await expect(renderer.mountPage(page, new AbortController().signal)).rejects.toThrow(
      'browser_client_page_renderer_request_send_failed'
    )

    const replacement = renderer.mountPage(page, new AbortController().signal)
    completeMount(harness)
    await expect(replacement).resolves.toEqual({ webContentsId: 91 })
  })

  it('rejects a colliding request ID without disturbing the admitted owner', async () => {
    const harness = createHarness({ createRequestId: () => 'request-reused' })
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const admitted = renderer.mountPage(page, new AbortController().signal)

    await expect(renderer.retirePage(page)).rejects.toThrow(
      'browser_client_page_renderer_request_id_conflict'
    )
    expect(harness.endpoint.send).toHaveBeenCalledTimes(1)

    completeMount(harness)
    await expect(admitted).resolves.toEqual({ webContentsId: 91 })
  })

  it('rejects pending work on disposal and unregisters the shared listener', async () => {
    const harness = createHarness()
    const renderer = harness.registry.attachRenderer(harness.endpoint)
    const mounted = renderer.mountPage(page, new AbortController().signal)

    harness.registry.dispose()

    await expect(mounted).rejects.toThrow('browser_client_page_renderer_registry_disposed')
    expect(renderer.isCurrent()).toBe(false)
    expect(harness.registry.selectRenderer).toThrow('browser_client_page_renderer_unavailable')
  })
})
