import { afterEach, expect, it, vi } from 'vitest'
const ports = vi.hoisted(() => ({ send: vi.fn<typeof fetch>() }))
vi.mock('expo/fetch', () => ({ fetch: ports.send }))
import { postPushRoute } from './push-route-http'
afterEach(() => {
  vi.useRealTimers()
  ports.send.mockReset()
})

it.each(['chunked', 'lying', 'declared', 'missing', 'utf8', 'json', 'late'] as const)(
  'bounds retained bytes and cancels/releases the actual Expo adapter for %s bodies',
  async (kind) => {
    const cancel = vi.fn()
    const controller = new AbortController()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const body =
      kind === 'missing'
        ? null
        : new ReadableStream<Uint8Array>({
            start(value) {
              stream = value
              if (kind === 'late') {
                return
              }
              if (kind === 'utf8') {
                value.enqueue(new Uint8Array([0xff]))
              } else if (kind === 'json') {
                value.enqueue(new TextEncoder().encode('{broken'))
              } else {
                value.enqueue(new Uint8Array(2048))
                value.enqueue(new Uint8Array(2049))
              }
              value.close()
            },
            cancel
          })
    const headers =
      kind === 'declared'
        ? { 'content-length': '9999' }
        : kind === 'lying'
          ? { 'content-length': '1' }
          : undefined
    const called = Promise.withResolvers<void>()
    ports.send.mockImplementation(async () => {
      called.resolve()
      return new Response(body, { headers })
    })
    const result = postPushRoute('{}', controller.signal)
    await called.promise
    if (kind === 'late') {
      controller.abort()
    }
    const reply = await result
    expect(reply.invalid || reply.status === 0).toBe(true)
    expect(body?.locked ?? false).toBe(false)
    expect(ports.send.mock.calls.at(0)?.[1]?.redirect).toBe('error')
    if (kind === 'late' || kind === 'declared') {
      expect(cancel).toHaveBeenCalledOnce()
      expect(ports.send.mock.calls.at(0)?.[1]?.signal?.aborted).toBe(true)
    }
    expect(stream !== undefined).toBe(kind !== 'missing')
  }
)
it('decodes a finite chunked strict reply and aborts the existing fifteen-second deadline', async () => {
  const bytes = new TextEncoder().encode('{"status":"current","version":null,"hosts":[]}')
  ports.send.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(value) {
          value.enqueue(bytes.subarray(0, 11))
          value.enqueue(bytes.subarray(11))
          value.close()
        }
      })
    )
  )
  expect(await postPushRoute('{}', new AbortController().signal)).toEqual({
    status: 200,
    data: { status: 'current', version: null, hosts: [] }
  })
  vi.useFakeTimers()
  const cancelled = vi.fn()
  const called = Promise.withResolvers<void>()
  ports.send.mockImplementation(async () => {
    called.resolve()
    return new Response(new ReadableStream({ cancel: cancelled }))
  })
  const pending = postPushRoute('{}', new AbortController().signal)
  await called.promise
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await pending).toEqual({ status: 0 })
  expect(cancelled).toHaveBeenCalledOnce()
})
