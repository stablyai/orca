import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { expect, it } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'

// Report stdin over a socket so terminal output wrapping cannot corrupt the byte oracle.
const PROBE = `
const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => {
  process.stdin.setRawMode(true);
  process.stdin.on('data', bytes => socket.write(bytes));
  process.stdin.resume();
  socket.write(process.argv[2] + '\\n');
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
`

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000)
    })
  ]).finally(() => clearTimeout(timer))
}

it('delivers a chunked paste and later controls in exact order to a real PTY stdin', async () => {
  const token = randomUUID()
  const sockets = new Set<Socket>()
  const chunks: Buffer[] = []
  const paste = 'abcé'.repeat(5000)
  const suffix = 'Z\t\x1b[A\x7f\r'
  const expected = Buffer.from(paste + suffix)
  let bytesReceived = 0
  let ready: () => void = () => {}
  let delivered: () => void = () => {}
  const inputReady = new Promise<void>((resolve) => {
    ready = resolve
  })
  const inputDelivered = new Promise<void>((resolve) => {
    delivered = resolve
  })
  let probe: IPty | undefined
  let probeExited: Promise<void> | undefined
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let handshake = Buffer.alloc(0)
    let authenticated = false
    socket.on('data', (data: Buffer) => {
      if (!authenticated) {
        handshake = Buffer.concat([handshake, data])
        const newline = handshake.indexOf(10)
        if (newline === -1) {
          if (handshake.length > 128) {
            socket.destroy()
          }
          return
        }
        if (handshake.subarray(0, newline).toString() !== token) {
          socket.destroy()
          return
        }
        authenticated = true
        data = handshake.subarray(newline + 1)
        handshake = Buffer.alloc(0)
        ready()
      }
      if (data.length > 0) {
        chunks.push(Buffer.from(data))
        bytesReceived += data.length
        if (bytesReceived >= expected.length) {
          delivered()
        }
      }
    })
    socket.on('error', () => socket.destroy())
  })

  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      }),
      'probe listener'
    )
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing probe port')
    }
    probe = spawn(process.execPath, ['-e', PROBE, String(address.port), token], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd()
    })
    probeExited = new Promise<void>((resolve) => probe!.onExit(() => resolve()))
    await deadline(inputReady, 'raw PTY input readiness')
    const writer = new RuntimeTerminalWriter((_pty, text) => {
      probe!.write(text)
      return true
    })
    await Promise.all([
      writer.writeAction('probe', { text: paste }, paste),
      writer.writeAction('probe', { text: suffix }, suffix)
    ])
    await deadline(inputDelivered, 'exact PTY stdin bytes')
    expect(Buffer.concat(chunks)).toEqual(expected)
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (probe) {
      try {
        probe.kill()
      } catch {
        /* The probe may have exited with its socket. */
      }
      await deadline(probeExited!, 'probe exit')
    }
  }
}, 15_000)
