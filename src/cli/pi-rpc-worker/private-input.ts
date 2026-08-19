import {
  BRACKETED_PASTE_END,
  MAX_PRIVATE_ENVELOPE_BYTES,
  decodePrivateDispatchEnvelope
} from './envelope'
import type { PiRpcWorkerDispatchEnvelope } from './types'

const PRIVATE_INPUT_SETTLE_MS = 20

export async function readPrivateDispatchFromStdin(
  stdin: NodeJS.ReadableStream
): Promise<PiRpcWorkerDispatchEnvelope> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settleTimer: NodeJS.Timeout | undefined
    let finished = false

    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.removeListener('error', onError)
      if (settleTimer) {
        clearTimeout(settleTimer)
      }
    }
    const fail = (error: Error): void => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      reject(error)
    }
    const decode = (): void => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      try {
        resolve(decodePrivateDispatchEnvelope(Buffer.concat(chunks, byteLength)))
      } catch (error) {
        reject(error)
      }
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      byteLength += bytes.byteLength
      if (byteLength > MAX_PRIVATE_ENVELOPE_BYTES) {
        fail(new Error('Private dispatch envelope exceeds byte limit'))
        return
      }
      chunks.push(bytes)
      const combined = Buffer.concat(chunks, byteLength)
      if (combined.includes(Buffer.from(BRACKETED_PASTE_END)) && !settleTimer) {
        settleTimer = setTimeout(decode, PRIVATE_INPUT_SETTLE_MS)
      }
    }
    const onEnd = (): void => decode()
    const onError = (): void => fail(new Error('Failed to read private dispatch envelope'))
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
    stdin.resume()
  })
}
