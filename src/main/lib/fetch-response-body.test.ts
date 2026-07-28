import { describe, expect, it, vi } from 'vitest'
import {
  FetchResponseBodyTooLargeError,
  readFetchResponseBytesWithinLimit,
  readFetchResponseJsonWithinLimit,
  readFetchResponseTextWithinLimit
} from './fetch-response-body'

function chunkedResponse(chunks: Uint8Array[], onCancel?: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
      cancel() {
        onCancel?.()
      }
    })
  )
}

describe('bounded fetch response bodies', () => {
  it('preserves bytes, split UTF-8, and parsed JSON below the limit', async () => {
    const encoded = new TextEncoder().encode('{"message":"hello 🐋"}')
    const chunks = [encoded.subarray(0, 20), encoded.subarray(20, 22), encoded.subarray(22)]

    await expect(readFetchResponseBytesWithinLimit(chunkedResponse(chunks), 1024)).resolves.toEqual(
      encoded
    )
    await expect(readFetchResponseTextWithinLimit(chunkedResponse(chunks), 1024)).resolves.toBe(
      '{"message":"hello 🐋"}'
    )
    await expect(
      readFetchResponseJsonWithinLimit<{ message: string }>(chunkedResponse(chunks), 1024)
    ).resolves.toEqual({ message: 'hello 🐋' })
  })

  it('rejects an oversized declared body before reading it', async () => {
    let cancelled = false
    const response = chunkedResponse([new Uint8Array([1])], () => {
      cancelled = true
    })
    response.headers.set('content-length', '1025')

    await expect(readFetchResponseBytesWithinLimit(response, 1024)).rejects.toThrow(
      FetchResponseBodyTooLargeError
    )
    expect(cancelled).toBe(true)
  })

  it('cancels a chunked body as soon as accumulated bytes exceed the limit', async () => {
    let cancelled = false
    const chunks = [new Uint8Array(700), new Uint8Array(400)]
    let index = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunks[index++] ?? new Uint8Array())
        },
        cancel() {
          cancelled = true
        }
      })
    )

    await expect(readFetchResponseBytesWithinLimit(response, 1024)).rejects.toThrow(
      FetchResponseBodyTooLargeError
    )
    expect(cancelled).toBe(true)
  })

  it('rejects invalid limits and preserves native JSON parse failures', async () => {
    await expect(readFetchResponseBytesWithinLimit(new Response('ok'), -1)).rejects.toThrow(
      RangeError
    )
    await expect(readFetchResponseJsonWithinLimit(new Response(''), 10)).rejects.toThrow(
      SyntaxError
    )
  })

  it('rejects structural amplification before JSON.parse', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse')

    await expect(
      readFetchResponseJsonWithinLimit(new Response('[0,0]'), 1024, {
        structuralTokens: 2,
        nestingDepth: 4
      })
    ).rejects.toThrow('JSON structure exceeds 2 tokens')
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('preserves injected adapters that expose only high-level response methods', async () => {
    const textResponse = { text: async () => 'adapter text' } as Response
    const jsonResponse = { json: async () => ({ source: 'adapter' }) } as Response

    await expect(readFetchResponseTextWithinLimit(textResponse)).resolves.toBe('adapter text')
    await expect(readFetchResponseJsonWithinLimit(jsonResponse)).resolves.toEqual({
      source: 'adapter'
    })
  })
})
