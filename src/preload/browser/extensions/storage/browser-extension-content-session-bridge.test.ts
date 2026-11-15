import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBrowserExtensionContentSessionBridge } from './browser-extension-content-session-bridge'
import { encodeBrowserExtensionWireJson } from '../../../../shared/browser/extensions/browser-extension-worker-api'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function documentBridge(eof = false, denied = false) {
  const lifecycle = new EventTarget()
  vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle))
  const connections: ReadableStreamDefaultController<Uint8Array>[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/mint')) {
      return new Response(encodeBrowserExtensionWireJson({ token: 'same-execution' }))
    }
    if (url.endsWith('/call')) {
      return new Response(encodeBrowserExtensionWireJson({ ok: true, value: {} }))
    }
    if (denied) {
      return new Response(null, { status: 403 })
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          connections.push(controller)
          init.signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.close()
              } catch {}
            },
            { once: true }
          )
          if (eof) {
            controller.close()
          }
        }
      })
    )
  })
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bridge = createBrowserExtensionContentSessionBridge('bootstrap')
  const received = vi.fn()
  bridge.onEvent(received)
  bridge.listen('orcaStorageSession', 'onChanged', true)
  return {
    bridge,
    fetch,
    connections,
    received,
    lifecycle: (type: string) =>
      lifecycle.dispatchEvent(Object.assign(new Event(type), { persisted: true })),
    send: (index: number, payload: unknown) =>
      connections[index].enqueue(
        new TextEncoder().encode(`${encodeBrowserExtensionWireJson(payload)}\n`)
      )
  }
}
const changed = {
  namespace: 'orcaStorageSession',
  event: 'onChanged',
  args: [{ saved: { newValue: 'current' } }]
}

it('resumes future delivery after overflow and across two preserved-document lifecycle cycles', async () => {
  const owner = documentBridge()
  await vi.advanceTimersByTimeAsync(0)
  owner.send(0, { control: 'overflow' })
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.connections).toHaveLength(2)
  owner.send(1, changed)
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.received).toHaveBeenLastCalledWith('orcaStorageSession', 'onChanged', [
    { saved: { newValue: 'current' } }
  ])
  for (let cycle = 0; cycle < 2; cycle++) {
    owner.lifecycle('pagehide')
    owner.lifecycle('pageshow')
    await vi.advanceTimersByTimeAsync(0)
    owner.send(cycle + 2, changed)
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(owner.received).toHaveBeenCalledTimes(3)
  owner.bridge.listen('orcaStorageSession', 'onChanged', false)
  await vi.advanceTimersByTimeAsync(0)
})

it('ends retired authority without reconnecting on later lifecycle or listener demand', async () => {
  const owner = documentBridge()
  await vi.advanceTimersByTimeAsync(0)
  owner.send(0, { control: 'retired' })
  await vi.advanceTimersByTimeAsync(0)
  owner.lifecycle('pagehide')
  owner.lifecycle('pageshow')
  owner.bridge.listen('orcaStorageSession', 'onChanged', false)
  owner.bridge.listen('orcaStorageSession', 'onChanged', true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(owner.connections).toHaveLength(1)
})

it('makes only one automatic recovery attempt when the transport repeatedly ends without delivery', async () => {
  const owner = documentBridge(true)
  await vi.runAllTimersAsync()
  expect(owner.connections).toHaveLength(2)
  owner.bridge.listen('orcaStorageSession', 'onChanged', false)
  await vi.runAllTimersAsync()
  expect(owner.connections).toHaveLength(2)
})

it('treats authentication refusal as terminal rather than repeatedly trying a stale capability', async () => {
  const owner = documentBridge(false, true)
  await vi.runAllTimersAsync()
  owner.lifecycle('pagehide')
  owner.lifecycle('pageshow')
  owner.bridge.listen('orcaStorageSession', 'onChanged', false)
  owner.bridge.listen('orcaStorageSession', 'onChanged', true)
  await vi.runAllTimersAsync()
  expect(owner.fetch.mock.calls.filter(([url]) => url.endsWith('/events'))).toHaveLength(1)
})

it.each([400 * 1024, 4000 * 1024])(
  'scans a %i-byte change split into 64KiB chunks only once',
  async (size) => {
    const owner = documentBridge()
    await vi.advanceTimersByTimeAsync(0)
    const payload = { ...changed, args: [{ saved: { newValue: 'x'.repeat(size) } }] }
    const wire = `${encodeBrowserExtensionWireJson(payload)}\n`
    const bytes = new TextEncoder().encode(wire)
    let scanned = 0
    const original = String.prototype.indexOf
    vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search, from) {
      if (search === '\n') {
        scanned += this.length - (from ?? 0)
      }
      return original.call(this, search, from)
    })
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      owner.connections[0].enqueue(bytes.subarray(offset, offset + 64 * 1024))
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(owner.received).toHaveBeenCalledExactlyOnceWith(
      'orcaStorageSession',
      'onChanged',
      payload.args
    )
    expect(scanned).toBeLessThanOrEqual(2 * wire.length)
    owner.bridge.listen('orcaStorageSession', 'onChanged', false)
  }
)
