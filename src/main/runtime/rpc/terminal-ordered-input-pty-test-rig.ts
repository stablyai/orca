import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { vi } from 'vitest'
import { RuntimeTerminalWriter } from '../runtime-terminal-writer'
import { stubRuntime } from './terminal-multiplex-test-harness'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

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

export function inputProofDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000)
    })
  ]).finally(() => clearTimeout(timer))
}

export async function createSocketPtyInputProbe(expected: Buffer) {
  const token = randomUUID()
  const sockets = new Set<Socket>()
  let ready!: () => void
  let delivered!: () => void
  const inputReady = new Promise<void>((resolve) => {
    ready = resolve
  })
  const inputDelivered = new Promise<void>((resolve) => {
    delivered = resolve
  })
  const received: Buffer[] = []
  let receivedBytes = 0
  let firstInputAt: number | undefined
  let probe: IPty | undefined
  let exited: Promise<void> | undefined
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
      if (data.length) {
        firstInputAt ??= performance.now()
        received.push(Buffer.from(data))
        receivedBytes += data.length
        if (receivedBytes >= expected.length) {
          delivered()
        }
      }
    })
    socket.on('error', () => socket.destroy())
  })
  const close = async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    if (server.listening) {
      await inputProofDeadline(
        new Promise<void>((resolve) => server.close(() => resolve())),
        'probe socket close'
      )
    }
    if (probe) {
      try {
        probe.kill()
      } catch {
        /* Already exited. */
      }
      await inputProofDeadline(exited!, 'PTY exit')
    }
  }
  try {
    await inputProofDeadline(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      }),
      'probe socket listen'
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
    exited = new Promise<void>((resolve) => probe!.onExit(() => resolve()))
    await inputProofDeadline(inputReady, 'raw PTY readiness')
  } catch (error) {
    await close()
    throw error
  }
  return {
    close,
    inputDelivered,
    write: (text: string) => probe!.write(text),
    bytes: () => Buffer.concat(received),
    firstInputAt: () => firstInputAt
  }
}

export async function createOrderedInputPtyTestRig(expected: Buffer) {
  const probe = await createSocketPtyInputProbe(expected)
  const writes: string[] = []
  const writer = new RuntimeTerminalWriter((_pty, text) => {
    writes.push(text)
    probe.write(text)
    return true
  })
  const registry = createSubscriptionRegistryDouble()
  const runtime = stubRuntime({
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: '', cols: 80, rows: 24 }),
    hasHeadlessTerminalState: vi.fn().mockReturnValue(true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn().mockReturnValue(1),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn(),
    beginMobileInputFloor: vi.fn(() => ({ commit: async () => {}, rollback: () => {} })),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    sendTerminal: async (handle, action, options) => {
      await writer.writeAction('pty-1', action, action.text ?? '', options)
      return { accepted: true, bytesWritten: Buffer.byteLength(action.text ?? ''), handle }
    }
  })
  return {
    runtime,
    writes,
    ...probe
  }
}
