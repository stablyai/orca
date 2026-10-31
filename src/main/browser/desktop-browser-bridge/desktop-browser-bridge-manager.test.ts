import { describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  DesktopBrowserBridgeManager,
  type DesktopBrowserBridgeCandidate,
  type DesktopBrowserBridgeManagerDeps
} from './desktop-browser-bridge-manager'

type Callbacks = Parameters<ReturnType<DesktopBrowserBridgeManagerDeps['subscribe']>>[0]

const HOST: DesktopBrowserBridgeCandidate = {
  environmentId: 'env-a',
  targetId: 'ssh-a',
  hostLabel: 'sandbox'
}

function event(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'attach', ok: true, result, _meta: { runtimeId: 'orcad' } }
}

function harness(options: { supports?: boolean } = {}) {
  let candidates: DesktopBrowserBridgeCandidate[] = [HOST]
  const subscriptions: {
    callbacks: Callbacks
    close: ReturnType<typeof vi.fn>
    sendRequest: ReturnType<typeof vi.fn>
  }[] = []
  const timers: { run: () => void; delayMs: number }[] = []
  const execute = vi.fn<DesktopBrowserBridgeManagerDeps['execute']>(async () => ({
    ok: true,
    result: { url: 'https://a.test/' }
  }))
  const subscribe = vi.fn(
    () =>
      async (callbacks: Callbacks): Promise<RemoteRuntimeSubscription> => {
        const entry = {
          callbacks,
          close: vi.fn(),
          sendRequest: vi.fn(async () => event({ accepted: true }))
        }
        subscriptions.push(entry)
        return {
          requestId: 'attach',
          close: entry.close,
          sendBinary: () => false,
          sendRequest: entry.sendRequest
        }
      }
  )
  const supportsBridge = vi.fn(async () => options.supports !== false)
  const manager = new DesktopBrowserBridgeManager({
    listCandidates: () => candidates,
    supportsBridge,
    subscribe,
    execute,
    log: () => {},
    setTimer: (run, delayMs) => {
      timers.push({ run, delayMs })
      return setTimeout(() => {}, 0)
    },
    clearTimer: () => {}
  })
  return {
    manager,
    subscriptions,
    timers,
    execute,
    subscribe,
    supportsBridge,
    setCandidates: (next: DesktopBrowserBridgeCandidate[]) => {
      candidates = next
    }
  }
}

describe('DesktopBrowserBridgeManager', () => {
  it('attaches an allowed, connected host and answers its requests over the same socket', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!

    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))
    expect(h.manager.isAttached('env-a')).toBe(true)
    socket.callbacks.onResponse(
      event({
        type: 'request',
        requestId: 'req-1',
        method: 'browser.goto',
        workspaceId: 'repo::/srv',
        params: { url: 'https://a.test', worktree: 'id:repo::/srv' }
      })
    )

    await vi.waitFor(() => expect(socket.sendRequest).toHaveBeenCalled())
    expect(h.execute).toHaveBeenCalledWith(
      HOST,
      expect.objectContaining({ requestId: 'req-1' }),
      expect.any(AbortSignal),
      expect.any(AbortSignal)
    )
    expect(socket.sendRequest).toHaveBeenCalledWith(
      'desktopBrowserBridge.result',
      { attachmentId: 'att-1', requestId: 'req-1', ok: true, result: { url: 'https://a.test/' } },
      expect.any(Number)
    )
  })

  it('never attaches to a server that does not advertise the bridge (an older orcad)', async () => {
    const h = harness({ supports: false })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.supportsBridge).toHaveBeenCalled())

    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.timers).toEqual([expect.objectContaining({ delayMs: 5 * 60_000 })])
  })

  it('retries soon when the server could not answer, instead of treating it as old', async () => {
    const h = harness()
    h.supportsBridge.mockRejectedValueOnce(new Error('runtime_unavailable'))
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.timers).toHaveLength(1))

    expect(h.timers[0]!.delayMs).toBe(2_000)
    h.timers[0]!.run()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
  })

  it('detaches at once when the setting turns off or the host disconnects', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    h.subscriptions[0]!.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    h.setCandidates([])
    h.manager.reconcile()

    expect(h.subscriptions[0]!.close).toHaveBeenCalled()
    expect(h.manager.isAttached('env-a')).toBe(false)
  })

  it('drops a request that arrives before readiness and reattaches with backoff', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))

    h.subscriptions[0]!.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.goto', params: {} })
    )

    expect(h.execute).not.toHaveBeenCalled()
    expect(h.subscriptions[0]!.close).toHaveBeenCalled()
    expect(h.timers).toEqual([expect.objectContaining({ delayMs: 2_000 })])
    h.timers[0]!.run()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(2))
  })

  it('refuses a forwarded method outside the allowlist at the protocol layer', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    h.subscriptions[0]!.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    h.subscriptions[0]!.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.cookie.get', params: {} })
    )

    expect(h.execute).not.toHaveBeenCalled()
    expect(h.subscriptions[0]!.close).toHaveBeenCalled()
  })

  it('does not retry a host that was removed while waiting', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    h.subscriptions[0]!.callbacks.onClose()
    h.setCandidates([])

    h.timers[0]!.run()

    await Promise.resolve()
    expect(h.subscriptions).toHaveLength(1)
  })

  it('revokes a command still running when the host detaches', async () => {
    const h = harness()
    let seen: AbortSignal | null = null
    h.execute.mockImplementationOnce(async (_candidate, _request, signal) => {
      seen = signal
      return { ok: true, result: {} }
    })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))
    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.goto', params: {} })
    )
    await vi.waitFor(() => expect(seen).not.toBeNull())

    h.setCandidates([])
    h.manager.reconcile()

    expect(seen!.aborted).toBe(true)
  })

  it('resetting an environment drops its socket and attaches again on a fresh one', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))

    h.manager.resetEnvironment('env-a')

    expect(h.subscriptions[0]!.close).toHaveBeenCalled()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(2))
  })

  it('accepts a request for a workspace whose id embeds a long path', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))
    const workspaceId = `repo-1::/${'deep/'.repeat(200)}app`

    socket.callbacks.onResponse(
      event({
        type: 'request',
        requestId: 'long',
        method: 'browser.tabList',
        workspaceId,
        params: { worktree: `id:${workspaceId}` }
      })
    )

    await vi.waitFor(() => expect(h.execute).toHaveBeenCalled())
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('tells the host at once when a finished command result cannot be delivered', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.sendRequest.mockRejectedValueOnce(new Error('outbound_message_too_large'))
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'big', method: 'browser.fullScreenshot', params: {} })
    )

    await vi.waitFor(() => expect(socket.sendRequest).toHaveBeenCalledTimes(2))
    expect(socket.sendRequest).toHaveBeenLastCalledWith(
      'desktopBrowserBridge.result',
      expect.objectContaining({
        requestId: 'big',
        ok: false,
        error: expect.objectContaining({ code: 'desktop_browser_bridge_result_undeliverable' })
      }),
      expect.any(Number)
    )
  })

  it('bounds a long browser error and falls back when the host refuses a result', async () => {
    const h = harness()
    h.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: 'browser_error', message: 'x'.repeat(10_000) }
    })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.sendRequest.mockResolvedValueOnce({
      id: 'r',
      ok: false,
      error: { code: 'invalid_argument', message: 'refused' },
      _meta: { runtimeId: 'orcad' }
    })
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'long', method: 'browser.eval', params: {} })
    )

    await vi.waitFor(() => expect(socket.sendRequest).toHaveBeenCalledTimes(2))
    expect(socket.sendRequest.mock.calls[0]?.[1]).toMatchObject({
      error: { code: 'browser_error', message: 'x'.repeat(4096) }
    })
    expect(socket.sendRequest).toHaveBeenLastCalledWith(
      'desktopBrowserBridge.result',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'desktop_browser_bridge_result_undeliverable' })
      }),
      expect.any(Number)
    )
  })

  it('never starts a command after orcad stopped waiting for it', async () => {
    const h = harness()
    let seen: AbortSignal | null = null
    h.execute.mockImplementationOnce(async (_candidate, _request, signal) => {
      seen = signal
      return { ok: true, result: {} }
    })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.click', timeoutMs: 20, params: {} })
    )

    await vi.waitFor(() => expect(seen).not.toBeNull())
    expect(seen!.aborted).toBe(false)
    await vi.waitFor(() => expect(seen!.aborted).toBe(true))
  })

  it('stops a queued or running command when orcad cancels it, and stays attached', async () => {
    const h = harness()
    let seen: AbortSignal | null = null
    let finish = (): void => {}
    h.execute.mockImplementationOnce(async (_candidate, _request, signal) => {
      seen = signal
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { ok: true, result: {} }
    })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))
    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.click', params: {} })
    )
    await vi.waitFor(() => expect(seen).not.toBeNull())
    expect(seen!.aborted).toBe(false)

    socket.callbacks.onResponse(event({ type: 'cancel', requestId: 'r' }))

    expect(seen!.aborted).toBe(true)
    expect(h.manager.isAttached('env-a')).toBe(true)
    finish()
  })

  it("hands each command a host signal that one command's cancel leaves alone", async () => {
    const h = harness()
    let host: AbortSignal | null = null
    h.execute.mockImplementationOnce(async (_candidate, _request, _signal, hostRevoked) => {
      host = hostRevoked
      return { ok: true, result: {} }
    })
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))
    socket.callbacks.onResponse(
      event({ type: 'request', requestId: 'r', method: 'browser.mouseDown', params: {} })
    )
    await vi.waitFor(() => expect(host).not.toBeNull())

    socket.callbacks.onResponse(event({ type: 'cancel', requestId: 'r' }))
    expect(host!.aborted).toBe(false)

    socket.callbacks.onClose()
    expect(host!.aborted).toBe(true)
  })

  it('ignores a cancel for a request it is not running', async () => {
    const h = harness()
    h.manager.reconcile()
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(1))
    const socket = h.subscriptions[0]!
    socket.callbacks.onResponse(event({ type: 'ready', attachmentId: 'att-1' }))

    socket.callbacks.onResponse(event({ type: 'cancel', requestId: 'unknown' }))

    expect(h.manager.isAttached('env-a')).toBe(true)
  })
})
