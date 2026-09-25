import {
  normalizeListenerWildcard,
  parseSocksRequest
} from '../../../src/shared/browser-socks-request'
import {
  ANDROID_BROWSER_CHUNK_BYTES,
  type AndroidBrowserByteStream
} from './android-browser-tunnel-socket'

export const ANDROID_SOCKS_REPLY = new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

export async function readAndroidSocksTarget(stream: AndroidBrowserByteStream) {
  let bytes = new Uint8Array(0)
  let greeting = true
  while (true) {
    if (greeting && bytes.byteLength >= 2 && bytes.byteLength >= 2 + bytes[1]!) {
      const length = 2 + bytes[1]!
      if (bytes[0] !== 5 || !bytes.subarray(2, length).includes(0)) {
        await stream.write(new Uint8Array([5, 255]))
        throw new Error('SOCKS authentication unsupported')
      }
      await stream.write(new Uint8Array([5, 0]))
      bytes = bytes.slice(length)
      greeting = false
    }
    if (!greeting) {
      const request = parseSocksRequest(bytes)
      if (request === null || (request && request.command !== 1)) {
        throw new Error('Invalid SOCKS CONNECT')
      }
      if (request) {
        return {
          target: normalizeListenerWildcard(request.target),
          initial: bytes.slice(request.consumed)
        }
      }
    }
    if (bytes.byteLength > 262) {
      throw new Error('SOCKS handshake exceeded limit')
    }
    const chunk = await stream.read()
    if (!chunk) {
      throw new Error('SOCKS handshake ended')
    }
    if (chunk.byteLength === 0 || chunk.byteLength > ANDROID_BROWSER_CHUNK_BYTES) {
      throw new Error('Invalid native chunk')
    }
    const combined = new Uint8Array(bytes.byteLength + chunk.byteLength)
    combined.set(bytes)
    combined.set(chunk, bytes.byteLength)
    bytes = combined
  }
}
