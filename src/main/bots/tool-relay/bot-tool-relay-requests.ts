// How the relay reads an agent's request: one header, the bounded body, and a refusal's status.
import type { IncomingMessage } from 'node:http'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const BODY_DEADLINE_MS = 10_000

export class RelayRefusal extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(', ') : value
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      req.destroy()
      reject(new RelayRefusal(408, 'The request took too long to arrive.'))
    }, BODY_DEADLINE_MS)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer)
        req.removeAllListeners('data')
        req.resume()
        reject(new RelayRefusal(413, 'The request is too large.'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
