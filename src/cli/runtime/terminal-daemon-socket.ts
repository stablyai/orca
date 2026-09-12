import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PROTOCOL_VERSION } from '../../main/daemon/daemon-protocol-version'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../main/daemon/daemon-spawner'
import { NOTIFY_PREFIX, type RpcResponse } from '../../main/daemon/types'
import { createNdjsonParser, encodeNdjson } from '../../shared/main-process-ndjson-framer'
import { getDefaultUserDataPath } from './metadata'

const HANDSHAKE_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000

type MessageWaiter = {
  resolve: (msg: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

// Why: both sockets are pure NDJSON; this gives sequential, timeout-bounded reads.
function nextMessageReader(socket: Socket): (timeoutMs?: number) => Promise<unknown> {
  const buffered: unknown[] = []
  const waiters: MessageWaiter[] = []
  const deliver = (msg: unknown): void => {
    const waiter = waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    } else {
      buffered.push(msg)
    }
  }
  const parser = createNdjsonParser(deliver, (err) => socket.destroy(err))
  // Why: decode across chunk boundaries so a multibyte UTF-8 sequence split by a
  // socket read isn't emitted as U+FFFD (matches the daemon's own readers).
  const decoder = new StringDecoder('utf8')
  socket.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)))
  // Why: post-connect errors surface as 'close'; an unhandled 'error' would crash the process.
  socket.on('error', () => {})
  socket.once('close', () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
  })
  return (timeoutMs) => {
    if (buffered.length > 0) {
      return Promise.resolve(buffered.shift())
    }
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = { resolve }
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((w) => w.timer === waiter.timer), 1)
          reject(new Error('Timed out waiting for daemon message'))
        }, timeoutMs)
      }
      waiters.push(waiter)
    })
  }
}

async function openSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const onError = (err: Error): void => {
      clearTimeout(timer)
      reject(err)
    }
    const timer = setTimeout(() => {
      socket.removeListener('error', onError)
      socket.destroy()
      reject(new Error(`Timed out connecting to daemon at ${socketPath}`))
    }, timeoutMs)
    socket.once('error', onError)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

function describeConnectError(err: unknown, socketPath: string): Error {
  if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
    return new Error(`Orca daemon socket not found at ${socketPath}. Start the Orca app first.`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

type DaemonIdentity = { pid?: number; startedAtMs?: number; launchNonce?: string }

async function sendHello(
  socket: Socket,
  token: string,
  clientId: string,
  role: 'control' | 'stream',
  nextMessage: (timeoutMs?: number) => Promise<unknown>,
  timeoutMs: number
): Promise<DaemonIdentity | undefined> {
  socket.write(encodeNdjson({ type: 'hello', version: PROTOCOL_VERSION, token, clientId, role }))
  const response = (await nextMessage(timeoutMs)) as
    | { ok?: boolean; error?: string; daemonIdentity?: DaemonIdentity }
    | undefined
  if (response?.ok !== true) {
    throw new Error(`Daemon rejected ${role} handshake: ${response?.error ?? 'unknown error'}`)
  }
  return response.daemonIdentity
}

// Why: a daemon replaced between the two connects would leave control and stream
// talking to different processes; the launchNonce is unique per daemon lifetime.
function assertSameDaemon(control?: DaemonIdentity, stream?: DaemonIdentity): void {
  if (
    control?.launchNonce !== undefined &&
    stream?.launchNonce !== undefined &&
    control.launchNonce !== stream.launchNonce
  ) {
    throw new Error(
      'Orca daemon was replaced mid-handshake; control and stream sockets reached different daemons. Retry.'
    )
  }
}

/** Two-socket NDJSON connection to the local Orca terminal daemon. */
export class TerminalDaemonConnection {
  static async connect(): Promise<TerminalDaemonConnection> {
    const runtimeDir = join(getDefaultUserDataPath(), 'daemon')
    const socketPath = getDaemonSocketPath(runtimeDir)
    const tokenPath = getDaemonTokenPath(runtimeDir)
    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new Error(`Orca daemon token not found at ${tokenPath}. Start the Orca app first.`)
      }
      throw err
    }
    const clientId = randomUUID()
    const control = await openSocket(socketPath, HANDSHAKE_TIMEOUT_MS).catch((err) => {
      throw describeConnectError(err, socketPath)
    })
    // Why: once control is open, any later failure must not leak an open socket.
    let stream: Socket | undefined
    try {
      const nextControlMessage = nextMessageReader(control)
      const controlIdentity = await sendHello(
        control,
        token,
        clientId,
        'control',
        nextControlMessage,
        HANDSHAKE_TIMEOUT_MS
      )
      // Why: the daemon silently drops a stream socket connected before the control handshake completes.
      stream = await openSocket(socketPath, HANDSHAKE_TIMEOUT_MS)
      const nextStreamMessage = nextMessageReader(stream)
      const streamIdentity = await sendHello(
        stream,
        token,
        clientId,
        'stream',
        nextStreamMessage,
        HANDSHAKE_TIMEOUT_MS
      )
      assertSameDaemon(controlIdentity, streamIdentity)
      return new TerminalDaemonConnection(control, stream, nextControlMessage, nextStreamMessage)
    } catch (err) {
      control.destroy()
      stream?.destroy()
      throw err
    }
  }

  private requestCounter = 0
  private notifyCounter = 0

  private constructor(
    private readonly controlSocket: Socket,
    private readonly streamSocket: Socket,
    private readonly nextControlMessage: (timeoutMs?: number) => Promise<unknown>,
    private readonly nextStreamMessage: (timeoutMs?: number) => Promise<unknown>
  ) {}

  async request<T>(type: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = `req-${++this.requestCounter}`
    this.controlSocket.write(encodeNdjson({ id, type, payload }))
    for (;;) {
      const response = (await this.nextControlMessage(timeoutMs)) as RpcResponse<T> | undefined
      if (response === undefined) {
        throw new Error('Daemon connection closed')
      }
      // Why: tolerate out-of-order responses from future protocol additions.
      if (response.id !== id) {
        continue
      }
      if (response.ok !== true) {
        throw new Error(response.error)
      }
      return response.payload
    }
  }

  // Why: fire-and-forget; the daemon never answers and the PTY keeps running regardless.
  notify(type: string, payload: unknown): void {
    const id = `${NOTIFY_PREFIX}${++this.notifyCounter}`
    this.controlSocket.write(encodeNdjson({ id, type, payload }))
  }

  // Why: onClose lets the attach runtime settle its bridge when the daemon drops
  // the stream (session gone / daemon exit) instead of awaiting forever.
  onEvent(listener: (event: unknown) => void, onClose?: () => void): void {
    void (async () => {
      for (;;) {
        const event = await this.nextStreamMessage()
        if (event === undefined) {
          onClose?.()
          return
        }
        listener(event)
      }
    })()
  }

  close(): void {
    this.controlSocket.destroy()
    this.streamSocket.destroy()
  }
}
