import { request } from 'node:http'
import { buildPaperclipApiUrl, type PaperclipOriginPolicy } from './paperclip-origin-policy'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
  }
}

export async function paperclipRequest(input: {
  policy: PaperclipOriginPolicy
  segments: readonly string[]
  query?: Readonly<Record<string, string | number | undefined>>
  deadlineMs?: number
}): Promise<unknown> {
  const url = buildPaperclipApiUrl(input.policy, input.segments, input.query)
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'Orca' },
        agent: false
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new PaperclipApiError('Paperclip redirects are not allowed.', status))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy(
              new PaperclipApiError(
                'Paperclip response exceeded the size limit.',
                response.statusCode ?? null
              )
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (status < 200 || status >= 300) {
            reject(new PaperclipApiError(readPaperclipError(text, status), status))
            return
          }
          if (status === 204 || text.trim().length === 0) {
            resolve(null)
            return
          }
          try {
            resolve(JSON.parse(text) as unknown)
          } catch {
            reject(new PaperclipApiError('Paperclip returned invalid JSON.', status))
          }
        })
      }
    )
    const deadline = setTimeout(
      () => req.destroy(new PaperclipApiError('Paperclip request timed out.', null)),
      input.deadlineMs ?? REQUEST_TIMEOUT_MS
    )
    req.once('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end()
  })
}

function readPaperclipError(text: string, status: number): string {
  try {
    const value = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (typeof value.error === 'string' && value.error.trim()) {
      return value.error
    }
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message
    }
  } catch {
    // Fall through to a bounded generic status message.
  }
  return `Paperclip request failed (${status}).`
}
