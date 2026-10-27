import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'

type MediaReader = {
  size: number
  read: (offset: number, length: number) => Promise<Uint8Array>
  close: () => Promise<void>
}

export async function createMediaRangeResponse(
  request: Request,
  mimeType: string,
  reader: MediaReader
): Promise<Response> {
  if (!Number.isSafeInteger(reader.size) || reader.size < 0) {
    await reader.close()
    throw new Error('Invalid media file size')
  }
  const headers = new Headers({
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  })
  const range = request.headers.get('range')
  let start = 0
  let end = reader.size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (
      match &&
      (match[1] || match[2]) &&
      (!match[1] || Number.isSafeInteger(Number(match[1]))) &&
      (!match[2] || Number.isSafeInteger(Number(match[2])))
    ) {
      start = match[1] ? Number(match[1]) : Math.max(0, reader.size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
    } else {
      start = -1
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      await reader.close()
      headers.set('Content-Range', `bytes */${reader.size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${reader.size}`)
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)))
  if (request.method === 'HEAD' || reader.size === 0) {
    await reader.close()
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  let closed = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    request.signal.removeEventListener('abort', abort)
    await reader.close()
  }
  const abort = (): void => {
    streamController?.error(new Error('Media request cancelled'))
    void close().catch(() => {})
  }
  request.signal.addEventListener('abort', abort, { once: true })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      if (request.signal.aborted) {
        abort()
      }
    },
    async pull(controller) {
      try {
        if (request.signal.aborted || closed) {
          throw new Error('Media request cancelled')
        }
        const bytes = await reader.read(start, Math.min(MAX_FILE_RANGE_READ_BYTES, end - start + 1))
        if (closed) {
          return
        }
        if (bytes.byteLength === 0) {
          throw new Error('Media file changed during playback')
        }
        start += bytes.byteLength
        controller.enqueue(bytes)
        if (start > end) {
          controller.close()
          await close()
        }
      } catch (error) {
        controller.error(error)
        await close()
      }
    },
    cancel: close
  })
  return new Response(body, { status: range ? 206 : 200, headers })
}
