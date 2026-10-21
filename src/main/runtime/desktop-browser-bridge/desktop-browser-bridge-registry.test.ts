import { describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserBridgeEvent } from '../../../shared/desktop-browser-bridge-protocol'
import {
  DesktopBrowserBridgeRegistry,
  MAX_PENDING_PER_ATTACHMENT
} from './desktop-browser-bridge-registry'

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
