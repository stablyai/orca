import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { PLUGIN_GUEST_CSP } from '../../../shared/plugins/frames/plugin-panel-shell'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'
export const JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8'

export function pluginFrameContentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Code the guest executes or renders as a document: read whole and checked byte-for-byte. */
export function isCheckedPluginFrameType(contentType: string): boolean {
  return /^(?:text\/html|text\/javascript|text\/css|application\/json|application\/wasm|image\/svg\+xml|application\/xml)/.test(
    contentType
  )
}

const COMMON_HEADERS = {
  // Why on every response: workers take their CSP from their own script response.
  'Content-Security-Policy': PLUGIN_GUEST_CSP,
  'X-Content-Type-Options': 'nosniff',
  // Reloads and dev edits must re-read (and re-verify) the plugin tree.
  'Cache-Control': 'no-store'
}

export function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

export function busy(): Response {
  return new Response(null, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' }
  })
}

/** One `bytes=start-end` range (media seeking); anything else is served whole. */
export function readRange(
  header: string | null,
  size: number
): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (match[1] === '' && match[2] === '')) {
    return null
  }
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start <= end && start < size ? { start, end } : null
}

/** A response for bytes already in memory (checked types and Orca's own files). */
export function bufferedResponse(
  request: Request,
  contentType: string,
  body: Uint8Array
): Response {
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      ...COMMON_HEADERS
    }
  })
}

/**
 * Streams a file (or one range of it) straight from disk, so large media never sits in memory.
 * `onDone` runs once when the body finishes, errors or is cancelled. HEAD answers from `size` alone.
 */
export function streamedResponse(
  request: Request,
  path: string,
  size: number,
  contentType: string,
  onDone: () => void
): Response {
  const range = readRange(request.headers.get('range'), size)
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(range ? range.end - range.start + 1 : size),
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
    ...COMMON_HEADERS
  }
  const status = range ? 206 : 200
  if (request.method === 'HEAD') {
    onDone()
    return new Response(null, { status, headers })
  }
  const file = createReadStream(path, range ?? {})
  const chunks = file[Symbol.asyncIterator]()
  let done = false
  const finish = (): void => {
    if (!done) {
      done = true
      file.destroy()
      onDone()
    }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) {
          finish()
          controller.close()
          return
        }
        const chunk: Buffer = next.value
        // A view, not a copy: the chunk is handed over as is.
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    cancel: finish
  })
  return new Response(body, { status, headers })
}
