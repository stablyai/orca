import { describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
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
      async (callbacks: Callbacks): Promise<RemoteRuntimeTransportSubscription> => {
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
})
