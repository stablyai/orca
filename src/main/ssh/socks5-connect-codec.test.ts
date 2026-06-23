import { describe, expect, it } from 'vitest'
import {
  buildConnectRequest,
  buildSocks5Greeting,
  Socks5ConnectClient,
  type Socks5Result
} from './socks5-connect-codec'

// A successful method-selection reply: version 5, no-auth chosen.
const METHOD_OK = Buffer.from([0x05, 0x00])
// A successful CONNECT reply with an IPv4 BND.ADDR 0.0.0.0:0.
const REPLY_OK_IPV4 = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])

function replyWithCode(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

describe('buildSocks5Greeting', () => {
  it('offers exactly the no-auth method', () => {
    expect([...buildSocks5Greeting()]).toEqual([0x05, 0x01, 0x00])
  })
})

describe('buildConnectRequest', () => {
  it('frames a domain CONNECT with big-endian port', () => {
    const req = buildConnectRequest('host', 0x1234)
    expect([...req]).toEqual([
      0x05,
      0x01,
      0x00,
      0x03,
      4, // domain length
      0x68,
      0x6f,
      0x73,
      0x74, // "host"
      0x12,
      0x34 // port 0x1234
    ])
  })

  it('rejects an empty host', () => {
    expect(() => buildConnectRequest('', 22)).toThrow(/1-255 bytes/)
  })

  it('rejects a host longer than 255 bytes', () => {
    expect(() => buildConnectRequest('a'.repeat(256), 22)).toThrow(/1-255 bytes/)
  })

  it('rejects out-of-range ports', () => {
    expect(() => buildConnectRequest('host', 0)).toThrow(/port out of range/)
    expect(() => buildConnectRequest('host', 70000)).toThrow(/port out of range/)
  })
})

// Drive a client through method selection. Returns the result of the final receive.
function feedAll(client: Socks5ConnectClient, chunks: Buffer[]): Socks5Result {
  let result: Socks5Result = { status: 'need-more' }
  for (const chunk of chunks) {
    result = client.receive(chunk)
  }
  return result
}

describe('Socks5ConnectClient method selection', () => {
  it('emits the CONNECT request once no-auth is accepted', () => {
    const client = new Socks5ConnectClient('example.ts.net', 22)
    const result = client.receive(METHOD_OK)
    expect(result.status).toBe('send')
    if (result.status === 'send') {
      expect([...result.data]).toEqual([...buildConnectRequest('example.ts.net', 22)])
    }
  })

  it('waits for more bytes when the selection arrives one byte at a time', () => {
    const client = new Socks5ConnectClient('h', 22)
    expect(client.receive(Buffer.from([0x05])).status).toBe('need-more')
    expect(client.receive(Buffer.from([0x00])).status).toBe('send')
  })

  it('errors when the server accepts no method', () => {
    const client = new Socks5ConnectClient('h', 22)
    const result = client.receive(Buffer.from([0x05, 0xff]))
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.message).toMatch(/no acceptable authentication/)
    }
  })

  it('errors on an unsupported auth method', () => {
    const client = new Socks5ConnectClient('h', 22)
    expect(client.receive(Buffer.from([0x05, 0x02])).status).toBe('error')
  })

  it('errors on a non-SOCKS5 version byte', () => {
    const client = new Socks5ConnectClient('h', 22)
    const result = client.receive(Buffer.from([0x04, 0x00]))
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.message).toMatch(/unexpected version/)
    }
  })
})

describe('Socks5ConnectClient reply parsing', () => {
  it('completes the handshake on an IPv4 success reply', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const result = client.receive(REPLY_OK_IPV4)
    expect(result.status).toBe('connected')
    if (result.status === 'connected') {
      expect(result.leftover.length).toBe(0)
    }
  })

  it('completes on a domain-typed BND.ADDR success reply', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    // ATYP domain (0x03), len 3, "abc", port 0.
    const reply = Buffer.from([0x05, 0x00, 0x00, 0x03, 3, 0x61, 0x62, 0x63, 0, 0])
    expect(client.receive(reply).status).toBe('connected')
  })

  it('completes on an IPv6-typed BND.ADDR success reply', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const reply = Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x04]),
      Buffer.alloc(16), // IPv6
      Buffer.alloc(2) // port
    ])
    expect(client.receive(reply).status).toBe('connected')
  })

  it('returns trailing tunnel bytes as leftover', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const result = client.receive(Buffer.concat([REPLY_OK_IPV4, Buffer.from('SSH-2.0\r\n')]))
    expect(result.status).toBe('connected')
    if (result.status === 'connected') {
      expect(result.leftover.toString()).toBe('SSH-2.0\r\n')
    }
  })

  it('reassembles a reply split across chunks', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    expect(client.receive(REPLY_OK_IPV4.subarray(0, 3)).status).toBe('need-more')
    expect(client.receive(REPLY_OK_IPV4.subarray(3)).status).toBe('connected')
  })

  it('maps connection-refused to ECONNREFUSED', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const result = client.receive(replyWithCode(0x05))
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect((result.error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
    }
  })

  it('maps host/network unreachable to errno codes', () => {
    for (const [code, errno] of [
      [0x04, 'EHOSTUNREACH'],
      [0x03, 'ENETUNREACH']
    ] as const) {
      const client = new Socks5ConnectClient('h', 22)
      client.receive(METHOD_OK)
      const result = client.receive(replyWithCode(code))
      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect((result.error as NodeJS.ErrnoException).code).toBe(errno)
      }
    }
  })

  it('surfaces a message for reply codes without an errno mapping', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const result = client.receive(replyWithCode(0x07))
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.message).toMatch(/command not supported/)
      expect((result.error as NodeJS.ErrnoException).code).toBeUndefined()
    }
  })

  it('errors on an unsupported reply address type', () => {
    const client = new Socks5ConnectClient('h', 22)
    client.receive(METHOD_OK)
    const reply = Buffer.from([0x05, 0x00, 0x00, 0x09, 0, 0])
    expect(client.receive(reply).status).toBe('error')
  })

  it('handles method selection and reply delivered in one chunk', () => {
    // Real proxies don't pipeline the reply before the request, but the codec
    // must not choke if both arrive together across two receive() calls.
    const client = new Socks5ConnectClient('h', 22)
    expect(client.receive(METHOD_OK).status).toBe('send')
    expect(feedAll(client, [REPLY_OK_IPV4]).status).toBe('connected')
  })
})
