/** Probe forwarding on each managed-tunnel start; sshd policy refusal selects the stdio bridge. */
import { connect, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../connection/ssh-connection'
import type { StartedPortForward } from './ssh-port-forward-provider'

export type TcpForwardingVerdict = 'allowed' | 'refused' | 'unverifiable'
/** `not-listening`: no dial ever connected, so the forward never got as far as its listener. */
export type ForwardChannelVerdict = TcpForwardingVerdict | 'not-listening'

/** RFC 4254 open-failure codes: sshd policy, versus a port with nothing listening. */
const ADMINISTRATIVELY_PROHIBITED = 1
const CONNECT_FAILED = 2
const TCP_FORWARDING_PROBE_TIMEOUT_MS = 10_000
const FORWARD_CHANNEL_CHECK_TIMEOUT_MS = 5_000
// Why: ssh -L binds only after its own login; a slow ProxyCommand (e.g. Coder) can take many seconds. Same budget as a system SSH connect.
const FORWARD_LISTEN_TIMEOUT_MS = 30_000
// The client logs a failed open just before it drops the socket; the two can arrive out of order.
const FORWARD_CHANNEL_FAILURE_LOG_GRACE_MS = 500
const FORWARD_CHANNEL_FAILURE_LOG_POLL_MS = 25
const FORWARD_CHANNEL_REDIAL_MS = 100
// Not HTTP: an HTTP server answers it with a 400 at once, proving bytes cross the channel.
const FORWARD_CHANNEL_CHECK_BYTES = '\0\r\n\r\n'

function closeQuietly(channel: ClientChannel | undefined): void {
  try {
    channel?.close()
  } catch {
    // A channel that already closed is the outcome we wanted.
  }
}

/** Connection refusal proves forwarding is allowed; only administrative refusal proves policy denial. */
export function probeTcpForwarding(
  connection: Pick<SshConnection, 'getClient'>,
  port: number,
  timeoutMs = TCP_FORWARDING_PROBE_TIMEOUT_MS
): Promise<TcpForwardingVerdict> {
  const client = connection.getClient()
  if (!client) {
    // Why: system SSH opens forwards in its own process; no channel answer reaches us here.
    return Promise.resolve('unverifiable')
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unverifiable'), timeoutMs)
    const settle = (verdict: TcpForwardingVerdict): void => {
      clearTimeout(timer)
      resolve(verdict)
    }
    try {
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) => {
        if (!error) {
          closeQuietly(channel)
          settle('allowed')
          return
        }
        // ssh2 copies the channel-open failure code onto the error as `reason`.
        const reason = 'reason' in error && typeof error.reason === 'number' ? error.reason : null
        settle(
          reason === ADMINISTRATIVELY_PROHIBITED
            ? 'refused'
            : reason === CONNECT_FAILED
              ? 'allowed'
              : 'unverifiable'
        )
      })
    } catch {
      settle('unverifiable')
    }
  })
}

export type ForwardChannelCheckOptions = {
  /** Wait for a reply once a dial connects. */
  channelTimeoutMs?: number
  /** Wait for the listener to come up, i.e. for the forward's own login. */
  listenTimeoutMs?: number
  /** Aborted when the forward exits: no listener can come up any more. */
  signal?: AbortSignal
}

/** A listener alone proves no remote channel: dial through it. Reply bytes or a channel still open at timeout prove it opened. */
export function checkForwardChannel(
  forward: Pick<StartedPortForward, 'entry' | 'lastChannelOpenFailure'>,
  {
    channelTimeoutMs = FORWARD_CHANNEL_CHECK_TIMEOUT_MS,
    listenTimeoutMs = FORWARD_LISTEN_TIMEOUT_MS,
    signal
  }: ForwardChannelCheckOptions = {}
): Promise<ForwardChannelVerdict> {
  const readFailure = forward.lastChannelOpenFailure
  if (!readFailure) {
    return Promise.resolve('unverifiable')
  }
  const verdictOf = (): TcpForwardingVerdict | null => {
    const failure = readFailure()
    return failure === 'administratively-prohibited'
      ? 'refused'
      : failure === 'connect-failed'
        ? 'allowed'
        : null
  }
  return new Promise((resolve) => {
    let settled = false
    let poll: ReturnType<typeof setInterval> | undefined
    let redial: ReturnType<typeof setTimeout> | undefined
    let socket: Socket | undefined
    let everConnected = false
    const settle = (verdict: ForwardChannelVerdict): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(redial)
      clearInterval(poll)
      signal?.removeEventListener('abort', onTimeout)
      socket?.destroy()
      resolve(verdict)
    }
    const onTimeout = (): void =>
      settle(verdictOf() ?? (everConnected ? 'unverifiable' : 'not-listening'))
    let timer = setTimeout(onTimeout, listenTimeoutMs)
    const awaitFailureLog = (): void => {
      if (settled || poll) {
        return
      }
      const deadline = Date.now() + FORWARD_CHANNEL_FAILURE_LOG_GRACE_MS
      const check = (): void => {
        const verdict = verdictOf()
        if (verdict || Date.now() >= deadline) {
          settle(verdict ?? 'unverifiable')
        }
      }
      poll = setInterval(check, FORWARD_CHANNEL_FAILURE_LOG_POLL_MS)
      check()
    }
    const dial = (): void => {
      let connected = false
      const current = connect({ host: '127.0.0.1', port: forward.entry.localPort })
      socket = current
      current.once('connect', () => {
        connected = true
        if (!everConnected) {
          // Listening proves the login finished; the channel answer gets its own, shorter wait.
          everConnected = true
          clearTimeout(timer)
          timer = setTimeout(onTimeout, channelTimeoutMs)
        }
        current.write(FORWARD_CHANNEL_CHECK_BYTES)
      })
      current.once('data', () => settle('allowed'))
      current.on('error', () => {})
      current.once('close', () => {
        if (connected) {
          awaitFailureLog()
        } else if (!settled) {
          // Why: the startup wait can end on its grace timer before ssh has bound the listener.
          redial = setTimeout(dial, FORWARD_CHANNEL_REDIAL_MS)
        }
      })
    }
    signal?.addEventListener('abort', onTimeout, { once: true })
    if (signal?.aborted) {
      onTimeout()
      return
    }
    dial()
  })
}
