import type { IncomingMessage } from 'node:http'
import type { PreviewNetworkResponse } from './chat-address-preview-network'

export const CHAT_PREVIEW_MEDIA_TIMEOUT_MS = 5 * 60_000
export const CHAT_PREVIEW_MAX_MEDIA_BYTES = 512 * 1024 * 1024

export function previewResponseSize(response: IncomingMessage): number | undefined {
  const contentRange = response.headers['content-range']
  const range =
    typeof contentRange === 'string' ? /^bytes \d+-\d+\/(\d+)$/.exec(contentRange) : null
  const raw =
    range?.[1] ?? (response.statusCode === 200 ? response.headers['content-length'] : undefined)
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return undefined
  }
  const size = Number(raw)
  return Number.isSafeInteger(size) ? size : undefined
}

/** A prefix request stops as soon as enough bytes arrive, even when Range was ignored. */
export async function readPreviewNetworkBytes(
  result: PreviewNetworkResponse,
  limit: number,
  prefix = false
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const value of result.response) {
      const chunk: Buffer = value
      const remaining = limit - total
      if (!prefix && chunk.length > remaining) {
        throw new Error('Preview file exceeds the size limit')
      }
      const bytes = chunk.subarray(0, remaining)
      chunks.push(bytes)
      total += bytes.length
      if (prefix && total >= limit) {
        break
      }
    }
    return Buffer.concat(chunks, total)
  } finally {
    result.close()
  }
}

/** Keep the socket backpressured; media bodies are never materialized in main. */
export function streamPreviewNetworkResponse(
  result: PreviewNetworkResponse,
  signal: AbortSignal,
  onClose: () => void
): ReadableStream<Uint8Array> {
  const iterator = result.response[Symbol.asyncIterator]()
  const timeout = (): void => {
    result.response.destroy(new Error('Preview media response timed out'))
  }
  result.response.once('timeout', timeout)
  let total = 0
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    signal.removeEventListener('abort', abort)
    result.response.setTimeout(0)
    result.response.removeListener('timeout', timeout)
    result.close()
    onClose()
  }
  const abort = (): void => {
    if (!closed) {
      controller.error(new Error('Preview cancelled'))
    }
    close()
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
    },
    async pull(value) {
      try {
        // Only a waiting reader needs an idle deadline; buffered playback may pause indefinitely.
        result.response.setTimeout(CHAT_PREVIEW_MEDIA_TIMEOUT_MS)
        let next: IteratorResult<Buffer>
        try {
          next = await iterator.next()
        } finally {
          result.response.setTimeout(0)
        }
        if (closed) {
          return
        }
        if (next.done) {
          value.close()
          close()
          return
        }
        total += next.value.length
        if (total > CHAT_PREVIEW_MAX_MEDIA_BYTES) {
          throw new Error('Preview media exceeds the size limit')
        }
        value.enqueue(next.value)
      } catch (error) {
        if (!closed) {
          value.error(error)
        }
        close()
      }
    },
    cancel: close
  })
}
