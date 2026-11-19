import { get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_READY_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 100
const MAX_FRAME_BYTES = 8 * 1024 * 1024

function hasFrame(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let bytes = Buffer.alloc(0)
    const finish = (ready: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      request.destroy()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const request = get(endpoint, (response) => {
      if (response.statusCode !== 200) {
        finish(false)
        return
      }
      response.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk])
        const start = bytes.indexOf(Buffer.from([0xff, 0xd8]))
        if (start !== -1 && bytes.includes(Buffer.from([0xff, 0xd9]), start + 2)) {
          finish(true)
        } else if (bytes.length > MAX_FRAME_BYTES) {
          finish(false)
        }
      })
      response.once('end', () => finish(false))
      response.once('error', () => finish(false))
    })
    request.once('error', () => finish(false))
  })
}

export async function waitForServeSimEndpointReady(
  endpoint: string,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS
): Promise<boolean> {
  try {
    if (new URL(endpoint).protocol !== 'http:') {
      return false
    }
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await hasFrame(endpoint, deadline - Date.now())) {
      return true
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return false
    }
    await delay(Math.min(RETRY_DELAY_MS, remaining))
  }
  return false
}
