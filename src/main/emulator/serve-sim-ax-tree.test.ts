import { describe, expect, it, vi } from 'vitest'
import { fetchServeSimAccessibilityTree } from './serve-sim-ax-tree'

function sseResponse(chunks: string[], init: { status?: number } = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

describe('fetchServeSimAccessibilityTree', () => {
  it('returns the first data event and skips the SSE comment preamble', async () => {
    const tree = { screen: { width: 393, height: 852 }, elements: [{ label: 'Login' }], errors: [] }
    const fetchImpl = vi.fn(async () => sseResponse([':\n\n', `data: ${JSON.stringify(tree)}\n\n`]))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).resolves.toEqual(tree)
  })

  it('prefers a live update over the replayed cached tree', async () => {
    // The helper replays the cached tree to new clients, then polls the device
    // and writes a fresh event only if the tree changed — the fresh one must win.
    const stale = JSON.stringify({ elements: [{ label: 'Old' }] })
    const fresh = JSON.stringify({ elements: [{ label: 'New' }] })
    const fetchImpl = vi.fn(async () =>
      sseResponse([':\n\n', `data: ${stale}\n\n`, `data: ${fresh}\n\n`])
    )
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).resolves.toEqual({ elements: [{ label: 'New' }] })
  })

  it('settles on the first event when no follow-up arrives within the window', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(':\n\n'))
        controller.enqueue(encoder.encode('data: {"elements":[]}\n\n'))
        // Never closes — an unchanged tree writes nothing, so the settle window must end the read.
      }
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl, settleMs: 30 })
    ).resolves.toEqual({ elements: [] })
  })

  it('handles a data event split across stream chunks', async () => {
    const payload = JSON.stringify({ elements: [] })
    const mid = Math.floor(payload.length / 2)
    const fetchImpl = vi.fn(async () =>
      sseResponse([':\n\n', `data: ${payload.slice(0, mid)}`, `${payload.slice(mid)}\n\n`])
    )
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).resolves.toEqual({ elements: [] })
  })

  it('maps a non-200 response to an actionable stale-helper error', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([], { status: 404 }))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('Restart the emulator session')
    })
  })

  it('maps a connection failure to emulator_no_active', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).rejects.toMatchObject({ code: 'emulator_no_active' })
  })

  it('fails when the stream ends without a data event', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([':\n\n', ':\n\n']))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
  })

  it('times out when no data event arrives', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Never emits and never closes; the timeout abort must win.
            }
          }),
          { status: 200 }
        )
    )
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'emulator_error', message: expect.stringMatching(/Timed out/) })
  })

  // Pull-based: controller.error() discards still-queued chunks, so the stream
  // must hand out each chunk on its own read before erroring on a later pull.
  function droppingSseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    let step = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step < chunks.length) {
          controller.enqueue(encoder.encode(chunks[step]))
          step += 1
        } else {
          controller.error(new TypeError('terminated'))
        }
      }
    })
    return new Response(body, { status: 200 })
  }

  it('returns the last captured tree when the stream drops uncleanly mid-read', async () => {
    const tree = { elements: [{ label: 'Captured' }] }
    const fetchImpl = vi.fn(async () =>
      droppingSseResponse([':\n\n', `data: ${JSON.stringify(tree)}\n\n`])
    )
    // settleMs is long so the drop, not the settle window, ends the read.
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl, settleMs: 5000 })
    ).resolves.toEqual(tree)
  })

  it('maps an unclean mid-stream drop with no captured tree to emulator_helper_failed', async () => {
    const fetchImpl = vi.fn(async () => droppingSseResponse([':\n\n']))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
  })

  it('returns the captured tree when the timeout aborts mid-settle', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(':\n\n'))
        controller.enqueue(encoder.encode('data: {"elements":[{"label":"Only"}]}\n\n'))
        // Never closes; the hard timeout must abort while the settle window is open.
      }
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', {
        fetchImpl,
        settleMs: 5000,
        timeoutMs: 40
      })
    ).resolves.toEqual({ elements: [{ label: 'Only' }] })
  })

  it('rejects an unparseable ax event with emulator_helper_failed', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([':\n\n', 'data: not-json\n\n']))
    await expect(
      fetchServeSimAccessibilityTree('http://127.0.0.1:3100/ax', { fetchImpl })
    ).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('unparseable')
    })
  })
})
