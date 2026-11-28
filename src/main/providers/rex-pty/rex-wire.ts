import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import WebSocket from 'ws'
import { validateRexLocalEndpoint } from './rex-local-endpoint'
import {
  rexDataReceiveBudget,
  rexControlReceiveBudget,
  rexSendBudget,
  rexDataWireBudget,
  rexControlWireBudget,
  REX_MAX_SNAPSHOT_BYTES
} from './rex-memory-budget'

const MAX = 64 * 1024 * 1024
const TIMEOUT = 5000
export const REX_WIRE_HIGH_BYTES = 1024 * 1024
const LOW_BYTES = 256 * 1024
const HIGH_FRAMES = 1024
const LOW_FRAMES = 256

export class RexWire {
  private socket: WebSocket
  private queue: { data: Buffer; release: () => void }[] = []
  private releaseFrame?: () => void
  private readonly releaseWire: () => void
  private readonly sends = new Set<() => void>()
  private bytes = 0
  private wake?: () => void
  private failure?: Error
  private pending = false
  private interrupted = false
  private receivePaused = false
  private disposed = false

  constructor(path: string, route: string, protocol: string) {
    const dataRoute = route === '/api/data'
    const budget = dataRoute ? rexDataReceiveBudget : rexControlReceiveBudget
    const wireLease = (dataRoute ? rexDataWireBudget : rexControlWireBudget).reserve(0)
    if (!wireLease) {
      throw new Error('Rex connection budget exhausted')
    }
    this.releaseWire = wireLease
    try {
      this.socket = new WebSocket(`ws://localhost${route}`, protocol, {
        createConnection: () => connect({ path }),
        handshakeTimeout: TIMEOUT,
        maxPayload: dataRoute ? REX_MAX_SNAPSHOT_BYTES : 1024 * 1024,
        perMessageDeflate: false
      })
    } catch (error) {
      wireLease()
      throw error
    }
    this.socket.on('message', (raw) => {
      if (this.disposed) {
        return
      }
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw)
      if (this.bytes + data.length > MAX || this.queue.length >= 16384) {
        this.fail(new Error('Rex receive queue overflow'))
        this.close()
        return
      }
      const release = budget.reserve(data.length + 128)
      if (!release) {
        this.fail(new Error('Rex aggregate receive budget exhausted'))
        this.close()
        return
      }
      this.queue.push({ data, release })
      this.bytes += data.length
      if (
        route === '/api/data' &&
        !this.receivePaused &&
        (this.bytes >= REX_WIRE_HIGH_BYTES || this.queue.length >= HIGH_FRAMES)
      ) {
        this.receivePaused = true
        this.socket.pause()
      }
      this.wake?.()
    })
    this.socket.on('open', () => this.wake?.())
    this.socket.on('error', (error) => {
      if (!this.failure) {
        // Only a transport interruption permits replay from the acknowledged offset.
        // WebSocket protocol/size/UTF-8 violations and unknown errors fail closed.
        this.interrupted =
          'code' in error &&
          (error.code === 'ECONNRESET' ||
            error.code === 'EPIPE' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ECONNABORTED')
      }
      this.fail(error)
    })
    this.socket.on('close', (code, reason) => {
      this.releaseWire()
      this.releaseSends()
      if (!this.failure) {
        this.interrupted =
          code === 1006 || (code === 1001 && reason.toString() === 'keepalive timeout')
      }
      this.fail(new Error('Rex socket closed'))
    })
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.wake?.()
  }

  private async waitUntil(ready: () => boolean, timeout?: number): Promise<void> {
    if (this.pending) {
      throw new Error('Rex wire requires a single reader')
    }
    this.pending = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.wake = () => {
          if (ready()) {
            resolve()
          } else if (this.failure) {
            reject(this.failure)
          }
        }
        if (timeout !== undefined) {
          timer = setTimeout(() => reject(new Error('Rex read timeout')), timeout)
        }
        this.wake()
      })
    } finally {
      clearTimeout(timer)
      this.wake = undefined
      this.pending = false
    }
  }

  async ready(): Promise<void> {
    await this.waitUntil(() => this.socket.readyState === WebSocket.OPEN, TIMEOUT)
  }

  async next(timeout?: number): Promise<Buffer> {
    if (this.pending) {
      throw new Error('Rex wire requires a single reader')
    }
    // The previous frame is owned by the single reader until it asks for the next.
    this.releaseFrame?.()
    this.releaseFrame = undefined
    await this.waitUntil(() => this.queue.length > 0, timeout)
    const frame = this.queue.shift()
    if (!frame) {
      throw this.failure ?? new Error('Rex receive queue unavailable')
    }
    this.bytes -= frame.data.length
    this.releaseFrame = frame.release
    if (
      this.receivePaused &&
      this.bytes <= LOW_BYTES &&
      this.queue.length <= LOW_FRAMES &&
      this.socket.readyState === WebSocket.OPEN &&
      !this.failure
    ) {
      this.receivePaused = false
      this.socket.resume()
    }
    return frame.data
  }

  send(data: string | Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.failure) {
      throw new Error('Rex wire unavailable')
    }
    const lease = rexSendBudget.reserve(
      (typeof data === 'string' ? Buffer.byteLength(data) : data.length) + 128
    )
    if (!lease) {
      throw new Error('Rex aggregate send budget exhausted')
    }
    const release = () => {
      this.sends.delete(release)
      lease()
    }
    this.sends.add(release)
    try {
      this.socket.send(data, (error) => {
        release()
        if (error) {
          this.fail(error)
          this.close()
        }
      })
    } catch (error) {
      release()
      throw error
    }
  }

  /** A paused receiver must not be mistaken for a dead transport; its existing
   * bounded delivery gate remains responsible for stalled-consumer recovery. */
  async probeWake(): Promise<boolean> {
    if (this.failure || this.disposed || this.socket.readyState !== WebSocket.OPEN) {
      return false
    }
    if (this.receivePaused) {
      return true
    }
    const token = randomBytes(16)
    return new Promise((resolve) => {
      const finish = (healthy: boolean) => {
        clearTimeout(timer)
        this.socket.removeListener('pong', onPong)
        this.socket.removeListener('close', onClose)
        resolve(healthy)
      }
      const onPong = (data: Buffer) => {
        if (data.equals(token)) {
          finish(true)
        }
      }
      const onClose = () => finish(false)
      const timer = setTimeout(() => finish(this.receivePaused && !this.failure), 2500)
      this.socket.on('pong', onPong)
      this.socket.once('close', onClose)
      try {
        this.socket.ping(token, true, (error) => {
          if (error) {
            finish(false)
          }
        })
      } catch {
        finish(false)
      }
    })
  }

  get canResume(): boolean {
    return this.interrupted
  }

  private releaseSends(): void {
    for (const release of this.sends) {
      release()
    }
  }

  close(): void {
    this.disposed = true
    this.interrupted = false
    for (const frame of this.queue) {
      frame.release()
    }
    this.releaseFrame?.()
    this.releaseFrame = undefined
    this.queue = []
    this.bytes = 0
    this.fail(new Error('Rex wire disposed'))
    this.socket.terminate()
  }
}

/** Own the candidate connection until negotiation succeeds, including cancellation. */
export async function handshakeRexWire<T>(
  path: string,
  route: string,
  protocol: string,
  negotiate: (wire: RexWire) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const endpoint = await validateRexLocalEndpoint(path)
  signal?.throwIfAborted()
  const wire = new RexWire(endpoint, route, protocol)
  const abort = () => wire.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await wire.ready()
    signal?.throwIfAborted()
    const result = await negotiate(wire)
    signal?.throwIfAborted()
    return result
  } catch (error) {
    wire.close()
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
