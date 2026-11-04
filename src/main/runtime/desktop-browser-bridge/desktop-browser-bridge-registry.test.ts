import { describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserBridgeEvent } from '../../../shared/desktop-browser-bridge-protocol'
import {
  DesktopBrowserBridgeRegistry,
  MAX_PENDING_PER_ATTACHMENT
} from './desktop-browser-bridge-registry'
import { routeDesktopBrowserBridgeRpc } from './desktop-browser-bridge-route'

describe('--expect-url through the desktop bridge', () => {
  const route = (registry: DesktopBrowserBridgeRegistry) =>
    routeDesktopBrowserBridgeRpc({
      method: 'browser.click',
      params: { page: 'page-1', element: '@e1', expectUrl: 'https://example.com/a' },
      caller: { kind: 'local-cli' },
      hostEnabled: true,
      registry,
      localBrowserAvailable: true,
      resolveWorkspace: async (selector) => ({ id: selector })
    })

  it('refuses when the desktop commands would go to cannot enforce it', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const emit = vi.fn()
    registry.attach({ connectionId: 'new', pairedDeviceId: 'd', enforcesExpectUrl: true, emit })
    registry.attach({ connectionId: 'old', pairedDeviceId: 'd', emit })

    await expect(route(registry)).rejects.toMatchObject({ code: 'browser_expect_url_unsupported' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('checks the desktop left after resolving the workspace, not the one before', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const olderEmit = vi.fn()
    registry.attach({ connectionId: 'old', pairedDeviceId: 'd', emit: olderEmit })
    const newer = registry.attach({
      connectionId: 'new',
      pairedDeviceId: 'd',
      enforcesExpectUrl: true,
      emit: vi.fn()
    })

    await expect(
      routeDesktopBrowserBridgeRpc({
        method: 'browser.click',
        params: { worktree: 'wt', element: '@e1', expectUrl: 'https://example.com/a' },
        caller: { kind: 'local-cli' },
        hostEnabled: true,
        registry,
        localBrowserAvailable: true,
        resolveWorkspace: async (selector) => {
          newer.detach()
          return { id: selector }
        }
      })
    ).rejects.toMatchObject({ code: 'browser_expect_url_unsupported' })
    expect(olderEmit).not.toHaveBeenCalled()
  })

  it('forwards it to a desktop that enforces it and keeps the mismatch diagnostics', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const events: DesktopBrowserBridgeEvent[] = []
    const { attachmentId } = registry.attach({
      connectionId: 'c',
      pairedDeviceId: 'd',
      enforcesExpectUrl: true,
      emit: (event) => events.push(event)
    })

    const routing = route(registry)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const [request] = events
    expect(request).toMatchObject({
      type: 'request',
      params: { expectUrl: 'https://example.com/a' }
    })
    const data = { expectedUrl: 'https://example.com/a', actualUrl: 'https://example.com/b' }
    registry.settle(
      { connectionId: 'c', pairedDeviceId: 'd' },
      {
        attachmentId,
        requestId: request.type === 'request' ? request.requestId : '',
        ok: false,
        error: { code: 'browser_expected_url_mismatch', message: 'moved', data }
      }
    )

    await expect(routing).rejects.toMatchObject({ code: 'browser_expected_url_mismatch', data })
  })
})

describe('DesktopBrowserBridgeRegistry', () => {
  it('keeps waiting commands under what one desktop socket can answer at once', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    registry.attach({ connectionId: 'c', pairedDeviceId: 'd', emit: () => {} })
    const waiting = Array.from({ length: MAX_PENDING_PER_ATTACHMENT }, () =>
      registry.forward({ method: 'browser.snapshot', params: {} }, { timeoutMs: 60_000 })
    )
    for (const pending of waiting) {
      pending.catch(() => {})
    }

    await expect(
      registry.forward({ method: 'browser.snapshot', params: {} }, { timeoutMs: 60_000 })
    ).rejects.toMatchObject({ code: 'browser_busy' })
    expect(MAX_PENDING_PER_ATTACHMENT).toBeLessThan(32)
  })

  it('gives the desktop a deadline that ends before orcad stops waiting', () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const events: DesktopBrowserBridgeEvent[] = []
    registry.attach({ connectionId: 'c', pairedDeviceId: 'd', emit: (event) => events.push(event) })

    registry.forward({ method: 'browser.click', params: {} }, { timeoutMs: 60_000 }).catch(() => {})

    expect(events[0]).toMatchObject({ type: 'request', timeoutMs: 50_000 })
  })

  it('tells a cancel-capable desktop to drop a command the CLI cancelled', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const events: DesktopBrowserBridgeEvent[] = []
    registry.attach({
      connectionId: 'c',
      pairedDeviceId: 'd',
      acceptsCancel: true,
      emit: (event) => events.push(event)
    })
    const cli = new AbortController()

    const pending = registry.forward(
      { method: 'browser.click', params: {} },
      { timeoutMs: 60_000, signal: cli.signal }
    )
    cli.abort()

    await expect(pending).rejects.toMatchObject({ code: 'browser_aborted' })
    const sent = events[0]
    expect(sent?.type).toBe('request')
    expect(events[1]).toEqual({
      type: 'cancel',
      requestId: sent?.type === 'request' ? sent.requestId : ''
    })
  })

  it('never sends a cancel to an older desktop, which would drop its attachment on it', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    const events: DesktopBrowserBridgeEvent[] = []
    registry.attach({ connectionId: 'c', pairedDeviceId: 'd', emit: (event) => events.push(event) })
    const cli = new AbortController()

    const pending = registry.forward(
      { method: 'browser.click', params: {} },
      { timeoutMs: 60_000, signal: cli.signal }
    )
    cli.abort()

    await expect(pending).rejects.toMatchObject({ code: 'browser_aborted' })
    expect(events.map((event) => event.type)).toEqual(['request'])
  })

  it('cancels on the desktop when orcad stops waiting at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const registry = new DesktopBrowserBridgeRegistry()
      const events: DesktopBrowserBridgeEvent[] = []
      registry.attach({
        connectionId: 'c',
        pairedDeviceId: 'd',
        acceptsCancel: true,
        emit: (event) => events.push(event)
      })
      const pending = registry.forward(
        { method: 'browser.click', params: {} },
        { timeoutMs: 60_000 }
      )
      pending.catch(() => {})

      await vi.advanceTimersByTimeAsync(60_000)

      await expect(pending).rejects.toMatchObject({ code: 'browser_timeout' })
      expect(events.map((event) => event.type)).toEqual(['request', 'cancel'])
    } finally {
      vi.useRealTimers()
    }
  })
})
