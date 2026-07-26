import { describe, expect, it } from 'vitest'
import { responseBodyIncludesWithinLimit } from '../../scripts/bounded-response-body.mjs'

function responseWithChunks(chunks: string[], contentLength?: number): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    }),
    { headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) } }
  )
}

describe('responseBodyIncludesWithinLimit', () => {
  it('matches a marker split across admitted chunks', async () => {
    const response = responseWithChunks(['packager-', 'status:running'])
    await expect(
      responseBodyIncludesWithinLimit(response, 'packager-status:running', 64)
    ).resolves.toBe(true)
  })

  it('rejects streamed and declared bodies above the byte limit', async () => {
    const streamed = responseWithChunks(['1234', '5'])
    const declared = responseWithChunks(['ok'], 5)

    await expect(responseBodyIncludesWithinLimit(streamed, 'missing', 4)).resolves.toBe(false)
    await expect(responseBodyIncludesWithinLimit(declared, 'ok', 4)).resolves.toBe(false)
  })
})
