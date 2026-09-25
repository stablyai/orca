import type { Socket } from 'node:net'
import type { PairingTunnel } from '../../shared/mobile-relay-pairing-offer'
import {
  type connectThroughSocks5,
  Socks5NegotiationAbortedError,
  Socks5NegotiationError,
  Socks5RefusalError
} from './socks5-connect'

const DIAL_ATTEMPTS = 3
const DEFAULT_DIAL_RETRY_DELAY_MS = 1_500

export type RunningTailcatSocksProxy = { generation: number; port: number }

type TailcatSocksDialOptions = {
  tunnel: PairingTunnel
  signal: AbortSignal
  connect: typeof connectThroughSocks5
  currentRecovery: () => Promise<boolean> | null
  ensureStarted: () => Promise<RunningTailcatSocksProxy>
  beginAttempt: (generation: number) => void
  endAttempt: (generation: number) => void
  acceptSocket: (socket: Socket, proxy: RunningTailcatSocksProxy) => void
  recoverIdleProxy: (generation: number) => Promise<boolean>
  isStopped: () => boolean
  retryDelayMs?: number
  logf?: (message: string) => void
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Socks5NegotiationAbortedError()
  }
}

function waitForResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Socks5NegotiationAbortedError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => finish(() => reject(new Socks5NegotiationAbortedError()))
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Socks5NegotiationAbortedError())
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(resolve), delayMs)
    const onAbort = (): void => finish(() => reject(new Socks5NegotiationAbortedError()))
    const finish = (settle: () => void): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function dialTailcatSocks(options: TailcatSocksDialOptions): Promise<Socket> {
  let recoveryAttempted = false
  let attempt = 0
  let genericFailures = 0
  let attemptGeneration: number | null = null
  for (;;) {
    throwIfAborted(options.signal)
    const recovery = options.currentRecovery()
    if (recovery) {
      await waitForResult(recovery, options.signal)
    }
    const proxy = await waitForResult(options.ensureStarted(), options.signal)
    if (proxy.generation !== attemptGeneration) {
      attemptGeneration = proxy.generation
      attempt = 0
      genericFailures = 0
    }
    attempt += 1
    options.beginAttempt(proxy.generation)
    let failure: unknown
    try {
      const socket = await options.connect({
        proxyPort: proxy.port,
        host: options.tunnel.token,
        port: options.tunnel.port,
        signal: options.signal
      })
      if (options.signal.aborted) {
        socket.destroy()
        throw new Socks5NegotiationAbortedError()
      }
      options.acceptSocket(socket, proxy)
      return socket
    } catch (error) {
      failure = options.isStopped() ? new Error('Tailcat proxy has been stopped') : error
    } finally {
      options.endAttempt(proxy.generation)
    }

    throwIfAborted(options.signal)
    genericFailures =
      failure instanceof Socks5RefusalError && failure.replyCode === 0x01 ? genericFailures + 1 : 0
    if (attempt < DIAL_ATTEMPTS && failure instanceof Socks5RefusalError) {
      options.logf?.(`[tailcat socks] dial attempt ${attempt} failed: ${String(failure)}`)
      await waitForRetry(options.retryDelayMs ?? DEFAULT_DIAL_RETRY_DELAY_MS, options.signal)
      continue
    }
    const recoverable =
      (failure instanceof Socks5NegotiationError &&
        !(failure instanceof Socks5NegotiationAbortedError)) ||
      genericFailures >= DIAL_ATTEMPTS
    if (!recoveryAttempted && recoverable) {
      recoveryAttempted = true
      throwIfAborted(options.signal)
      if (await waitForResult(options.recoverIdleProxy(proxy.generation), options.signal)) {
        continue
      }
    }
    throw failure
  }
}
