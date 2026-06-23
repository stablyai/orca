// Sans-I/O SOCKS5 CONNECT client (RFC 1928), no-authentication method only.
//
// This is a pure protocol state machine: it has no socket. The caller writes the
// bytes it returns and feeds back the bytes it receives. That keeps the wire
// logic deterministic and exhaustively testable; the socket shell that drives it
// lives in ssh-tailscale-dialer.ts.
//
// We only speak CONNECT with a domain-name destination, because the tailnet
// sidecar's SOCKS5 proxy resolves MagicDNS names server-side — the desktop never
// resolves tailnet names locally.

const SOCKS_VERSION = 0x05
const METHOD_NO_AUTH = 0x00
const METHOD_NONE_ACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const RSV = 0x00
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const REP_SUCCEEDED = 0x00

const MAX_DOMAIN_BYTES = 255

// REP codes mapped to a Node errno where one fits, so the existing transient-error
// classification (isTransientError) treats a refused/unreachable tailnet dial the
// same as a refused/unreachable direct dial.
const REPLY_ERRORS: Record<number, { message: string; code?: string }> = {
  0x01: { message: 'general SOCKS server failure' },
  0x02: { message: 'connection not allowed by ruleset' },
  0x03: { message: 'network unreachable', code: 'ENETUNREACH' },
  0x04: { message: 'host unreachable', code: 'EHOSTUNREACH' },
  0x05: { message: 'connection refused', code: 'ECONNREFUSED' },
  0x06: { message: 'TTL expired' },
  0x07: { message: 'command not supported' },
  0x08: { message: 'address type not supported' }
}

export type Socks5Result =
  | { status: 'need-more' }
  | { status: 'send'; data: Buffer }
  /** Handshake complete. `leftover` is any bytes received after the reply that
   *  already belong to the tunneled stream and must be re-emitted to ssh2. */
  | { status: 'connected'; leftover: Buffer }
  | { status: 'error'; error: Error }

type State = 'awaiting-method' | 'awaiting-reply'

export function buildSocks5Greeting(): Buffer {
  return Buffer.from([SOCKS_VERSION, 0x01, METHOD_NO_AUTH])
}

export function buildConnectRequest(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, 'utf8')
  if (hostBytes.length === 0 || hostBytes.length > MAX_DOMAIN_BYTES) {
    throw new Error(
      `SOCKS5 destination host must be 1-${MAX_DOMAIN_BYTES} bytes, got ${hostBytes.length}`
    )
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SOCKS5 destination port out of range: ${port}`)
  }
  const req = Buffer.alloc(4 + 1 + hostBytes.length + 2)
  req[0] = SOCKS_VERSION
  req[1] = CMD_CONNECT
  req[2] = RSV
  req[3] = ATYP_DOMAIN
  req[4] = hostBytes.length
  hostBytes.copy(req, 5)
  req.writeUInt16BE(port, 5 + hostBytes.length)
  return req
}

function socks5Error(message: string, code?: string): Error {
  const err = new Error(`SOCKS5 CONNECT failed: ${message}`)
  if (code) {
    ;(err as NodeJS.ErrnoException).code = code
  }
  return err
}

// Returns the address length implied by an ATYP byte, or null if the address is
// not yet fully buffered / the ATYP is unknown.
function replyAddressLength(atyp: number, available: number): number | null {
  if (atyp === ATYP_IPV4) {
    return 4
  }
  if (atyp === ATYP_IPV6) {
    return 16
  }
  if (atyp === ATYP_DOMAIN) {
    // Header (4 bytes) is already consumed by the caller; the domain-length byte
    // sits at offset 0 of the remainder.
    if (available < 1) {
      return null
    }
    return -1 // signal: caller must read the length byte
  }
  return null
}

/** Drives one CONNECT handshake. Construct, send `greeting()`, then call
 *  `receive()` with each chunk until it returns `connected` or `error`. */
export class Socks5ConnectClient {
  private state: State = 'awaiting-method'
  private buffer: Buffer = Buffer.alloc(0)

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  greeting(): Buffer {
    return buildSocks5Greeting()
  }

  receive(chunk: Buffer): Socks5Result {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    if (this.state === 'awaiting-method') {
      const methodResult = this.parseMethodSelection()
      if (methodResult) {
        return methodResult
      }
    }
    if (this.state === 'awaiting-reply') {
      return this.parseReply()
    }
    return { status: 'need-more' }
  }

  private parseMethodSelection(): Socks5Result | null {
    if (this.buffer.length < 2) {
      return { status: 'need-more' }
    }
    const version = this.buffer[0]
    const method = this.buffer[1]
    if (version !== SOCKS_VERSION) {
      return { status: 'error', error: socks5Error(`unexpected version 0x${version.toString(16)}`) }
    }
    if (method === METHOD_NONE_ACCEPTABLE) {
      return { status: 'error', error: socks5Error('no acceptable authentication methods') }
    }
    if (method !== METHOD_NO_AUTH) {
      return {
        status: 'error',
        error: socks5Error(`unsupported auth method 0x${method.toString(16)}`)
      }
    }
    // Method accepted: advance, retain any leftover bytes for the reply parser,
    // and tell the caller to send the CONNECT request.
    this.buffer = this.buffer.subarray(2)
    this.state = 'awaiting-reply'
    return { status: 'send', data: buildConnectRequest(this.host, this.port) }
  }

  private parseReply(): Socks5Result {
    if (this.buffer.length < 4) {
      return { status: 'need-more' }
    }
    const version = this.buffer[0]
    const reply = this.buffer[1]
    const atyp = this.buffer[3]
    if (version !== SOCKS_VERSION) {
      return { status: 'error', error: socks5Error(`unexpected version 0x${version.toString(16)}`) }
    }

    const remainder = this.buffer.subarray(4)
    let addrLen = replyAddressLength(atyp, remainder.length)
    if (addrLen === null) {
      // Unknown ATYP only if we have the byte to know it's unknown; otherwise wait.
      if (atyp !== ATYP_DOMAIN && atyp !== ATYP_IPV4 && atyp !== ATYP_IPV6) {
        return {
          status: 'error',
          error: socks5Error(`unsupported reply address type 0x${atyp.toString(16)}`)
        }
      }
      return { status: 'need-more' }
    }
    if (addrLen === -1) {
      // Domain: length-prefixed.
      addrLen = 1 + remainder[0]
    }

    const totalReplyLen = 4 + addrLen + 2
    if (this.buffer.length < totalReplyLen) {
      return { status: 'need-more' }
    }

    if (reply !== REP_SUCCEEDED) {
      const mapped = REPLY_ERRORS[reply] ?? { message: `reply code 0x${reply.toString(16)}` }
      return { status: 'error', error: socks5Error(mapped.message, mapped.code) }
    }

    const leftover = this.buffer.subarray(totalReplyLen)
    return { status: 'connected', leftover: Buffer.from(leftover) }
  }
}
