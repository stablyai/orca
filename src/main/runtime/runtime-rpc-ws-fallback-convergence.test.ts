import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'
import { readWsFallbackPort } from './rpc/ws-fallback-port-store'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'
const ALL_INTERFACES = '0.0.0.0'

const heldSockets: Server[] = []
let restoreListen: (() => void) | null = null

afterEach(async () => {
  restoreListen?.()
  restoreListen = null
  await Promise.all(
    heldSockets
      .splice(0)
      .map((socket) => new Promise<void>((resolve) => socket.close(() => resolve())))
  )
  vi.restoreAllMocks()
})

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-ws-fallback-'))
}

function fallbackFile(userDataPath: string): string {
  return join(userDataPath, FALLBACK_PORT_FILE)
}

function seedFallback(userDataPath: string, port: number): void {
  writeFileSync(fallbackFile(userDataPath), JSON.stringify({ port }), 'utf8')
}

type ReservedPort = { port: number; release: () => Promise<void> }

// Why: the reserving socket keeps listening until the caller is ready, so nothing else on the machine can
// take the port in between — picking a port and closing immediately is a TOCTOU flake under load.
async function reservePort(): Promise<ReservedPort> {
  const socket = createServer()
  heldSockets.push(socket)
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', () => resolve()))
  const { port } = socket.address() as AddressInfo
  return {
    port,
    release: async () => {
      // Why: a second release would splice(-1) and untrack someone else's socket.
      const index = heldSockets.indexOf(socket)
      if (index !== -1) {
        heldSockets.splice(index, 1)
      }
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }
  }
}

// Why: reproduce host-level bind refusals (reserved ranges, descriptor exhaustion) that cannot be staged
// with a real socket.
function blockListen(
  isBlocked: (port: number, host: string) => boolean,
  makeError: (port: number, host: string) => Error
): () => void {
  const prototype = WebSocketTransport.prototype as unknown as {
    tryListen: (port: number) => Promise<void>
    host: string
  }
  const original = prototype.tryListen
  prototype.tryListen = function (port: number): Promise<void> {
    return isBlocked(port, this.host)
      ? Promise.reject(makeError(port, this.host))
      : original.call(this, port)
  }
  return () => {
    prototype.tryListen = original
  }
}

function listenDenied(port: number): Error {
  return Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), {
    code: 'EACCES',
    syscall: 'listen',
    port
  })
}

function portInUse(port: number): Error {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use ${port}`), {
    code: 'EADDRINUSE',
    syscall: 'listen',
    port
  })
}

async function startRuntime(options: {
  userDataPath: string
  wsPort: number
  preferPinnedWsPort?: boolean
}): Promise<OrcaRuntimeRpcServer> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: options.userDataPath,
    enableWebSocket: true,
    wsPort: options.wsPort,
    preferPinnedWsPort: options.preferPinnedWsPort
  })
  await server.start()
  return server
}

function servedPort(server: OrcaRuntimeRpcServer): number | null {
  const endpoint = server.getWebSocketEndpoint()
  return endpoint === null ? null : Number(new URL(endpoint).port)
}

describe('OrcaRuntimeRpcServer persisted WS fallback convergence (STA-4859)', () => {
  it('drops a fallback the OS refused to listen on once the configured port served', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const reserved = await reservePort()
    seedFallback(userDataPath, reserved.port)
    restoreListen = blockListen((port) => port === reserved.port, listenDenied)
    await configured.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(server)).toBe(configured.port)
      // Why: an EACCES listen means the OS itself holds the port for this boot, so the pairing behind it is
      // already dead — keeping the file is what re-armed it and flip-flopped the advertised endpoint.
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)
    } finally {
      await server.stop()
    }

    // Why: the reserved range moved after a reboot, so the old port is bindable again. Fallback-first order
    // (STA-1511) would re-take it and strand every device paired to the configured port.
    restoreListen()
    restoreListen = null
    await reserved.release()
    const relaunched = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(relaunched)).toBe(configured.port)
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)
    } finally {
      await relaunched.stop()
    }
  })

  it('keeps a fallback that was merely occupied and re-binds it once free', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const squatted = await reservePort()
    seedFallback(userDataPath, squatted.port)
    await configured.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(server)).toBe(configured.port)
      // Why: occupation is transient (an outbound ephemeral socket is enough) and a phone has no recovery
      // for a dropped endpoint but re-pairing, so one bad launch must not discard a live pairing. The keep
      // holds while the configured port serves; if it were taken too, the OS-assigned fall-through still
      // overwrites the fallback, as it does on main.
      expect(readWsFallbackPort(userDataPath)).toBe(squatted.port)
    } finally {
      await server.stop()
    }

    await squatted.release()
    const relaunched = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      // Why: STA-1511's self-heal — the pairing comes back on its own once the squatter leaves.
      expect(servedPort(relaunched)).toBe(squatted.port)
      expect(readWsFallbackPort(userDataPath)).toBe(squatted.port)
    } finally {
      await relaunched.stop()
    }
  })

  it('keeps a fallback whose bind failed for an unclassified reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const fallback = await reservePort()
    seedFallback(userDataPath, fallback.port)
    // Why: the transport falls through the fallback candidate on ANY error, so process-wide failures like
    // descriptor exhaustion reach the same branch — they say nothing about the port and must not clear it.
    restoreListen = blockListen(
      (port) => port === fallback.port,
      () =>
        Object.assign(new Error('listen EMFILE: too many open files'), {
          code: 'EMFILE',
          syscall: 'listen'
        })
    )
    await configured.release()
    await fallback.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(server)).toBe(configured.port)
      expect(readWsFallbackPort(userDataPath)).toBe(fallback.port)
    } finally {
      await server.stop()
    }
  })

  it('keeps a bindable fallback winning over the configured port (STA-1511)', async () => {
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const fallback = await reservePort()
    seedFallback(userDataPath, fallback.port)
    await configured.release()
    await fallback.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      // Why: devices paired to the fallback keep reconnecting only while it stays served and persisted.
      expect(servedPort(server)).toBe(fallback.port)
      expect(readWsFallbackPort(userDataPath)).toBe(fallback.port)
    } finally {
      await server.stop()
    }
  })

  it('leaves an untried fallback in place when a pinned port wins (#9005)', async () => {
    const userDataPath = makeUserDataPath()
    const pinned = await reservePort()
    const fallback = await reservePort()
    seedFallback(userDataPath, fallback.port)
    await pinned.release()
    await fallback.release()

    const server = await startRuntime({
      userDataPath,
      wsPort: pinned.port,
      preferPinnedWsPort: true
    })
    try {
      expect(servedPort(server)).toBe(pinned.port)
      // Why: pinned-first means the fallback was never attempted, so nothing proves it dead — clearing it
      // here would discard a working endpoint that a later default launch still hands back to devices.
      expect(readWsFallbackPort(userDataPath)).toBe(fallback.port)
    } finally {
      await server.stop()
    }
  })

  it('keeps the fallback when a pinned port is busy and the fallback serves (#9005)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const pinned = await reservePort()
    const fallback = await reservePort()
    seedFallback(userDataPath, fallback.port)
    await fallback.release()

    const server = await startRuntime({
      userDataPath,
      wsPort: pinned.port,
      preferPinnedWsPort: true
    })
    try {
      expect(servedPort(server)).toBe(fallback.port)
      expect(readWsFallbackPort(userDataPath)).toBe(fallback.port)
    } finally {
      await server.stop()
    }
  })

  it('never touches the store when the port is OS-assigned (wsPort 0, E2E)', async () => {
    const userDataPath = makeUserDataPath()
    const seeded = '{"port":54321}'
    writeFileSync(fallbackFile(userDataPath), seeded, 'utf8')

    const server = await startRuntime({ userDataPath, wsPort: 0 })
    try {
      expect(servedPort(server)).not.toBe(0)
      expect(readFileSync(fallbackFile(userDataPath), 'utf8')).toBe(seeded)
    } finally {
      await server.stop()
    }
  })

  it('leaves the store untouched when the WebSocket transport fails to start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const fallback = await reservePort()
    const seeded = JSON.stringify({ port: fallback.port })
    writeFileSync(fallbackFile(userDataPath), seeded, 'utf8')
    // Why: a non-listen EACCES is not a fall-through candidate error, so the configured port rethrows and
    // the whole WS start fails — a failed bind must never mutate what the next launch will trust.
    restoreListen = blockListen(
      () => true,
      () => Object.assign(new Error('open EACCES'), { code: 'EACCES', syscall: 'open' })
    )
    await configured.release()
    await fallback.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(server.getWebSocketEndpoint()).toBeNull()
      expect(readFileSync(fallbackFile(userDataPath), 'utf8')).toBe(seeded)
    } finally {
      await server.stop()
    }
  })

  it('persists an OS-assigned port when the configured port is taken and re-binds it next launch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    let assignedPort: number | null = null
    try {
      assignedPort = servedPort(server)
      expect(assignedPort).not.toBe(configured.port)
      expect(readWsFallbackPort(userDataPath)).toBe(assignedPort)
    } finally {
      await server.stop()
    }

    await configured.release()
    const relaunched = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      // Why: STA-1511 stability — the freed configured port must not steal the endpoint devices paired to.
      expect(servedPort(relaunched)).toBe(assignedPort)
      expect(readWsFallbackPort(userDataPath)).toBe(assignedPort)
    } finally {
      await relaunched.stop()
    }
  })

  it('persists the widen port when the pairing rebind cannot retake the configured port', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    await configured.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(server)).toBe(configured.port)
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)

      // Why: the widen stops the loopback listener before re-binding, so a port lost in that gap lands the
      // LAN listener on an OS-assigned one — which the QR already advertises and devices must find again.
      restoreListen = blockListen((port) => port === configured.port, portInUse)
      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(true)

      const widenedPort = servedPort(server)
      expect(widenedPort).not.toBe(configured.port)
      expect(readWsFallbackPort(userDataPath)).toBe(widenedPort)
    } finally {
      await server.stop()
    }
  })

  it('leaves the store alone when a failed widen recovers on a different loopback port', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configured = await reservePort()
    const fallback = await reservePort()
    seedFallback(userDataPath, fallback.port)
    await configured.release()
    await fallback.release()

    const server = await startRuntime({ userDataPath, wsPort: configured.port })
    try {
      expect(servedPort(server)).toBe(fallback.port)
      const seeded = readFileSync(fallbackFile(userDataPath), 'utf8')

      // Why: fail the wide bind outright and make the loopback restore miss its old port, so recovery lands
      // on an OS-assigned one — a degraded listener that serves no pairing.
      restoreListen = blockListen(
        (port, host) => host === ALL_INTERFACES || port === fallback.port,
        (port, host) =>
          host === ALL_INTERFACES
            ? Object.assign(new Error('open EACCES'), { code: 'EACCES', syscall: 'open' })
            : portInUse(port)
      )
      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(false)

      // Why: persisting the recovery port would overwrite the fallback that paired devices still dial, for
      // a listener that cannot serve them anyway.
      expect(servedPort(server)).not.toBe(fallback.port)
      expect(readFileSync(fallbackFile(userDataPath), 'utf8')).toBe(seeded)
    } finally {
      await server.stop()
    }
  })
})
