import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { DebugAdapterEventMessage } from '../../shared/debug-session-types'
import { DapMessageDecoder, encodeDapMessage } from './dap-message-framing'

export type DapRequestMessage = {
  seq: number
  type: 'request'
  command: string
  arguments?: unknown
}

export type DapResponseMessage = {
  seq: number
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

/** Re-exported under the DAP-specific name main-process code uses; identical to the shared IPC event payload shape. */
export type DapEventMessage = DebugAdapterEventMessage

type DapProtocolMessage = DapRequestMessage | DapResponseMessage | DapEventMessage

function isDapProtocolMessage(value: unknown): value is DapProtocolMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    ((value as { type: unknown }).type === 'request' ||
      (value as { type: unknown }).type === 'response' ||
      (value as { type: unknown }).type === 'event')
  )
}

type PendingRequest = {
  resolve: (body: unknown) => void
  reject: (err: Error) => void
}

/** Acknowledges a reverse request. `success: false` surfaces `message` as the adapter-visible error. */
export type ReverseRequestResponder = (body?: unknown, success?: boolean, message?: string) => void

/**
 * Thin DAP transport client: sends `request`s over an adapter process's
 * stdin, correlates responses off `stdout` by `request_seq`, and re-emits
 * out-of-band adapter events. No session-lifecycle knowledge lives here —
 * see `DebugSessionStateMachine` for `initialize`/`launch`/... sequencing.
 */
export class DapClient extends EventEmitter {
  private readonly stdin: Writable
  private readonly decoder = new DapMessageDecoder()
  private nextSeq = 0
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false

  constructor(stdin: Writable, stdout: Readable, stderr?: Readable) {
    super()
    this.stdin = stdin
    this.decoder.on('message', (msg: unknown) => {
      if (isDapProtocolMessage(msg)) {
        this.handleMessage(msg)
      }
    })
    this.decoder.on('error', (err: Error) => this.emit('error', err))
    stdout.on('data', (chunk: Buffer) => this.decoder.push(chunk))
    stdout.on('close', () => this.handleClose())
    stderr?.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')))
  }

  /** Sends a DAP request and resolves with its response body, or rejects on an unsuccessful response / closed transport. */
  request(command: string, args?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`DAP client is closed; cannot send request "${command}"`))
    }
    this.nextSeq += 1
    const seq = this.nextSeq
    const message: DapRequestMessage = { seq, type: 'request', command, arguments: args }
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject })
      this.stdin.write(encodeDapMessage(message), (err) => {
        if (err) {
          this.pending.delete(seq)
          reject(err)
        }
      })
    })
  }

  /** Tears down the transport, rejecting any requests still awaiting a response. */
  close(): void {
    this.handleClose()
  }

  private handleMessage(msg: DapProtocolMessage): void {
    if (msg.type === 'response') {
      const pending = this.pending.get(msg.request_seq)
      if (!pending) {
        return
      }
      this.pending.delete(msg.request_seq)
      if (msg.success) {
        pending.resolve(msg.body)
      } else {
        pending.reject(new Error(msg.message ?? `DAP request "${msg.command}" failed`))
      }
      return
    }
    if (msg.type === 'event') {
      this.emit('event', msg)
      return
    }
    if (msg.type === 'request') {
      this.handleReverseRequest(msg)
    }
  }

  /**
   * Adapter -> client requests (`startDebugging`, `runInTerminal`, ...). A
   * command with no `reverseRequest` listener is auto-acknowledged with an
   * empty success response — every DAP request needs a reply, and an
   * unhandled reverse request would otherwise leave the adapter's internal
   * state machine waiting forever.
   */
  private handleReverseRequest(msg: DapRequestMessage): void {
    let responded = false
    const respond: ReverseRequestResponder = (body, success = true, message) => {
      if (responded || this.closed) {
        return
      }
      responded = true
      this.nextSeq += 1
      const response: DapResponseMessage = {
        seq: this.nextSeq,
        type: 'response',
        request_seq: msg.seq,
        success,
        command: msg.command,
        message,
        body
      }
      this.stdin.write(encodeDapMessage(response))
    }
    if (this.listenerCount('reverseRequest') === 0) {
      respond(undefined, true)
      return
    }
    this.emit('reverseRequest', msg, respond)
  }

  private handleClose(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(new Error('DAP client closed before response arrived'))
    }
    this.pending.clear()
    this.emit('close')
  }
}
