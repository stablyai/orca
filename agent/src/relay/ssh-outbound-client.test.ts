// src/relay/ssh-outbound-client.test.ts
// TASK-AG-EVM-005: dialOutboundSshTarget — real dial via mocked ssh2.Client,
// jumpHost double-hop, proxyCommand spawn+Duplex wrapping, and the security
// regression-guard (privateKeyPEM must never surface in a thrown error).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import * as net from 'node:net'
import { PassThrough } from 'node:stream'
import type { EphemeralVmRecipeSshTarget } from '../shared/ephemeral-vm-recipes'

// ── mock ssh2.Client ────────────────────────────────────────────────────────
// Why a hand-rolled EventEmitter-based fake instead of vi.fn() stubs: real
// code path uses `.once('ready'|'error', ...).connect(...)` — the fake needs
// real event semantics so both success and failure branches exercise the
// actual promise-wrapping logic in connectSsh2Client, not a mocked shortcut.
class FakeSsh2Client extends EventEmitter {
  connectConfig: unknown
  ended = false
  forwardOutCalls: unknown[] = []
  nextForwardOutError: Error | null = null
  nextForwardOutChannel: unknown = { fake: 'channel' }

  connect(config: unknown): this {
    this.connectConfig = config
    return this
  }

  end(): void {
    this.ended = true
  }

  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback?: (err: Error | undefined, channel: unknown) => void
  ): this {
    this.forwardOutCalls.push({ srcIP, srcPort, dstIP, dstPort })
    if (this.nextForwardOutError) {
      callback?.(this.nextForwardOutError, undefined)
    } else {
      callback?.(undefined, this.nextForwardOutChannel)
    }
    return this
  }
}

const createdClients: FakeSsh2Client[] = []

vi.mock('ssh2', () => ({
  // Why a `function` expression, not an arrow: vitest's mock constructor
  // trap uses Reflect.construct(impl, args) when the mock is invoked with
  // `new` — an arrow function has no [[Construct]] and throws "is not a
  // constructor" there.
  Client: vi.fn().mockImplementation(function () {
    const client = new FakeSsh2Client()
    createdClients.push(client)
    return client
  })
}))

// ── mock node:child_process ─────────────────────────────────────────────────
class FakeChildProcess extends EventEmitter {
  stdin = { write: vi.fn((_c: unknown, _e: unknown, cb?: () => void) => cb?.()), end: vi.fn() }
  stdout = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() })
  stderr = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() })
  kill = vi.fn()
}

let lastSpawnArgs: { command: string; options: unknown } | null = null
let lastSpawnedChild: FakeChildProcess | null = null

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, options: unknown) => {
    lastSpawnArgs = { command, options }
    lastSpawnedChild = new FakeChildProcess()
    return lastSpawnedChild
  })
}))

// ── mock node:fs/promises ───────────────────────────────────────────────────
// TASK-AG-EVM-008: dialOutboundSshTarget reads target.identityFilePath
// locally via readFile — mocked so tests never touch the real filesystem.
const readFile = vi.fn()

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFile(...args)
}))

beforeEach(() => {
  createdClients.length = 0
  lastSpawnArgs = null
  lastSpawnedChild = null
  readFile.mockReset()
  vi.clearAllMocks()
})

const BASE_TARGET: EphemeralVmRecipeSshTarget = {
  label: 'vm-1',
  host: 'vm1.example.com',
  port: 2222,
  username: 'deploy'
}

// Waits (via vi.waitFor, poll-based — not a fixed microtask/tick count) for
// the most-recently-created FakeSsh2Client to exist, then fires 'ready'/
// 'error' on it. TASK-AG-EVM-008: dialOutboundSshTarget now awaits
// resolvePrivateKey (itself async even on its synchronous-return branches,
// since awaiting any async function call yields at least one microtask)
// BEFORE constructing the ssh2 client — a fixed queueMicrotask no longer
// reliably lands after client construction, so this polls instead.
async function waitForLatestClient(): Promise<FakeSsh2Client> {
  await vi.waitFor(() => {
    if (createdClients.length === 0) {
      throw new Error('no ssh2 client created yet')
    }
  })
  return createdClients.at(-1) as FakeSsh2Client
}

function resolveNextClientReady(): void {
  void waitForLatestClient().then((client) => client.emit('ready'))
}

function rejectNextClientWithError(err: Error): void {
  void waitForLatestClient().then((client) => client.emit('error', err))
}

// TASK-AG-EVM-010: real ssh2 calls ConnectConfig.hostVerifier synchronously
// during the handshake, then aborts (emits 'error') if it returns false —
// this simulates exactly that against the fake client, exercising the SAME
// hostVerifier function buildConnectConfig actually builds (not a shortcut).
async function completeHandshakeWithHostKey(hostKey: Buffer): Promise<{ accepted: boolean }> {
  const client = await waitForLatestClient()
  const config = client.connectConfig as { hostVerifier?: (key: Buffer) => boolean }
  const accepted = config.hostVerifier ? config.hostVerifier(hostKey) : true
  if (accepted) {
    client.emit('ready')
  } else {
    client.emit('error', new Error('Host key verification failed'))
  }
  return { accepted }
}

function expectedFingerprint(hostKey: Buffer): string {
  const digest = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

describe('dialOutboundSshTarget — TOFU host-key verification (TASK-AG-EVM-010, Gap 4 fix)', () => {
  it('accepts any host key on first dial (no knownHostKeyFingerprint) and returns the observed fingerprint', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    const hostKey = Buffer.from('host-key-bytes-first-dial')

    const dialPromise = dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: 'k' })
    const { accepted } = await completeHandshakeWithHostKey(hostKey)
    const session = await dialPromise

    expect(accepted).toBe(true)
    expect(session.hostKeyFingerprint).toBe(expectedFingerprint(hostKey))
  })

  it('succeeds when the observed host key matches knownHostKeyFingerprint', async () => {
    const hostKey = Buffer.from('host-key-bytes-repeat-dial')
    const fingerprint = expectedFingerprint(hostKey)
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, knownHostKeyFingerprint: fingerprint },
      { privateKeyPEM: 'k' }
    )
    const { accepted } = await completeHandshakeWithHostKey(hostKey)
    const session = await dialPromise

    expect(accepted).toBe(true)
    expect(session.hostKeyFingerprint).toBe(fingerprint)
  })

  it('fails clearly (no silent accept) when the observed host key does NOT match knownHostKeyFingerprint', async () => {
    const hostKey = Buffer.from('host-key-bytes-CHANGED-unexpectedly')
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    // A realistic, distinctive key value — 'k' would coincidentally collide
    // with the literal "k" in "Host key verification failed" and get
    // scrubbed by scrubCredentialFromError, corrupting this assertion for a
    // reason unrelated to what this test actually checks.
    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, knownHostKeyFingerprint: 'SHA256:stale-fingerprint-from-a-prior-dial' },
      { privateKeyPEM: 'FAKE-KEY-PEM' }
    )
    const { accepted } = await completeHandshakeWithHostKey(hostKey)

    expect(accepted).toBe(false)
    // Fingerprint values are not secrets (public host-key hashes) — fine to
    // surface in the error, unlike privateKeyPEM/identityFilePath content.
    await expect(dialPromise).rejects.toThrow('Host key verification failed')
  })
})

describe('dialOutboundSshTarget — plain dial (no jumpHost/proxyCommand)', () => {
  it('connects with privateKeyPEM and returns a session wrapping the ssh2 client', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: 'FAKE-KEY-PEM' })

    expect(createdClients).toHaveLength(1)
    const client = createdClients[0]
    expect(client.connectConfig).toMatchObject({
      host: 'vm1.example.com',
      port: 2222,
      username: 'deploy',
      privateKey: 'FAKE-KEY-PEM',
      sock: undefined
    })
    expect(session.client).toBe(client)
  })

  it('connects with identityAgent (no privateKeyPEM) passed straight through as `agent`', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    await dialOutboundSshTarget({ ...BASE_TARGET, identityAgent: '/tmp/ssh-agent.sock' }, {})

    const client = createdClients[0]
    expect(client.connectConfig).toMatchObject({
      agent: '/tmp/ssh-agent.sock',
      privateKey: undefined
    })
  })

  it('close() ends the underlying client', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: 'k' })
    session.close()

    expect(createdClients[0].ended).toBe(true)
  })

  it('rejects when the ssh2 client emits error, and ends the client', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    rejectNextClientWithError(new Error('ECONNREFUSED'))

    await expect(dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: 'k' })).rejects.toThrow(
      'ECONNREFUSED'
    )
    expect(createdClients[0].ended).toBe(true)
  })
})

describe('dialOutboundSshTarget — identityFilePath (TASK-AG-EVM-008, Gap 1 fix)', () => {
  it('reads target.identityFilePath locally when no credential.privateKeyPEM is given', async () => {
    readFile.mockResolvedValue('FILE-KEY-CONTENTS')
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(
      { ...BASE_TARGET, identityFilePath: '/home/user/.ssh/id_ed25519' },
      {}
    )

    expect(readFile).toHaveBeenCalledWith('/home/user/.ssh/id_ed25519', 'utf8')
    expect(createdClients[0].connectConfig).toMatchObject({ privateKey: 'FILE-KEY-CONTENTS' })
    expect(session.client).toBe(createdClients[0])
  })

  it('prefers credential.privateKeyPEM over identityFilePath and never reads the file', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    await dialOutboundSshTarget(
      { ...BASE_TARGET, identityFilePath: '/home/user/.ssh/id_ed25519' },
      { privateKeyPEM: 'RPC-KEY' }
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(createdClients[0].connectConfig).toMatchObject({ privateKey: 'RPC-KEY' })
  })

  it('propagates a clear error (not a crash) when the identity file does not exist', async () => {
    readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory, open '/no/such/file'"), {
        code: 'ENOENT'
      })
    )
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    await expect(
      dialOutboundSshTarget({ ...BASE_TARGET, identityFilePath: '/no/such/file' }, {})
    ).rejects.toThrow('ENOENT')
    // No ssh2 client should ever be created — the read failure happens
    // before any connection attempt.
    expect(createdClients).toHaveLength(0)
  })

  it('never reads a file when neither privateKeyPEM nor identityFilePath is set (identityAgent-only)', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    await dialOutboundSshTarget({ ...BASE_TARGET, identityAgent: '/tmp/ssh-agent.sock' }, {})

    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('dialOutboundSshTarget — jumpHost double-hop', () => {
  it('dials the jump host first, then forwardOut()s to the real target and uses the channel as sock', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    // First created client = jump host client; second = real target client.
    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, jumpHost: 'bastion.example.com' },
      { privateKeyPEM: 'FAKE-KEY-PEM' }
    )
    await vi.waitFor(() => expect(createdClients.length).toBeGreaterThanOrEqual(1))
    createdClients[0].emit('ready') // jump host ready → triggers forwardOut synchronously
    await vi.waitFor(() => expect(createdClients.length).toBe(2))
    createdClients[1].emit('ready') // real target ready

    const session = await dialPromise

    const jumpClient = createdClients[0]
    expect(jumpClient.connectConfig).toMatchObject({
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      privateKey: 'FAKE-KEY-PEM'
    })
    expect(jumpClient.forwardOutCalls).toEqual([
      { srcIP: '127.0.0.1', srcPort: 0, dstIP: 'vm1.example.com', dstPort: 2222 }
    ])

    const targetClient = createdClients[1]
    expect(targetClient.connectConfig).toMatchObject({
      host: undefined,
      port: undefined,
      sock: jumpClient.nextForwardOutChannel
    })
    expect(session.client).toBe(targetClient)

    session.close()
    expect(jumpClient.ended).toBe(true)
    expect(targetClient.ended).toBe(true)
  })

  it('propagates a forwardOut error and ends the jump client', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, jumpHost: 'bastion.example.com' },
      { privateKeyPEM: 'k' }
    )
    await vi.waitFor(() => expect(createdClients.length).toBe(1))
    createdClients[0].nextForwardOutError = new Error('forwardOut failed')
    createdClients[0].emit('ready')

    await expect(dialPromise).rejects.toThrow('forwardOut failed')
    expect(createdClients[0].ended).toBe(true)
    // Real target client must never be created if the tunnel never opened.
    expect(createdClients).toHaveLength(1)
  })
})

describe('dialOutboundSshTarget — proxyCommand', () => {
  it('spawns the resolved command with %h/%p substituted, via shell:true (no hardcoded shell path)', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, proxyCommand: 'cloudflared access ssh --hostname %h --port %p' },
      { privateKeyPEM: 'k' }
    )
    await vi.waitFor(() => expect(createdClients.length).toBe(1))
    resolveNextClientReady()
    const session = await dialPromise
    session.close()

    expect(lastSpawnArgs?.command).toBe(
      'cloudflared access ssh --hostname vm1.example.com --port 2222'
    )
    expect(lastSpawnArgs?.options).toMatchObject({ shell: true })
    expect(lastSpawnArgs?.options).not.toHaveProperty('shell', '/bin/sh')

    const client = createdClients[0]
    expect(client.connectConfig).toMatchObject({ host: undefined, port: undefined })
    expect((client.connectConfig as { sock: unknown }).sock).toBeInstanceOf(Object)
  })

  it('forwards data written to the Duplex sock into the child process stdin', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    const dialPromise = dialOutboundSshTarget(
      { ...BASE_TARGET, proxyCommand: 'nc %h %p' },
      { privateKeyPEM: 'k' }
    )
    await vi.waitFor(() => expect(createdClients.length).toBe(1))
    resolveNextClientReady()
    await dialPromise

    const client = createdClients[0]
    const sock = (client.connectConfig as { sock: NodeJS.ReadWriteStream }).sock
    sock.write(Buffer.from('hello'))

    expect(lastSpawnedChild?.stdin.write).toHaveBeenCalledWith(
      Buffer.from('hello'),
      expect.anything(),
      expect.any(Function)
    )
  })
})

describe('security regression-guard: privateKeyPEM never appears in a thrown error', () => {
  it('scrubs privateKeyPEM out of the error message on connect failure', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    const secret = 'PRIVATE-KEY-SUPER-SECRET-XYZ'
    rejectNextClientWithError(new Error(`auth failed for key ${secret}`))

    let thrown: Error | null = null
    try {
      await dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: secret })
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown!.message).not.toContain(secret)
    expect(thrown!.message).toContain('[REDACTED]')
  })

  it('leaves unrelated error messages untouched when they do not contain the credential', async () => {
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    rejectNextClientWithError(new Error('ECONNREFUSED 127.0.0.1:2222'))

    await expect(
      dialOutboundSshTarget(BASE_TARGET, { privateKeyPEM: 'unrelated-secret' })
    ).rejects.toThrow('ECONNREFUSED 127.0.0.1:2222')
  })

  // TASK-AG-EVM-008: content read from identityFilePath must be scrubbed the
  // same way RPC-supplied privateKeyPEM already is — resolvePrivateKey feeds
  // the file's content into the same resolvedCredential.privateKeyPEM the
  // catch block scrubs with, so this is the same code path, not new logic.
  it('scrubs content read from identityFilePath out of the error message on connect failure', async () => {
    const fileSecret = 'FILE-READ-PRIVATE-KEY-CONTENTS'
    readFile.mockResolvedValue(fileSecret)
    rejectNextClientWithError(new Error(`auth failed for key ${fileSecret}`))
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')

    let thrown: Error | null = null
    try {
      await dialOutboundSshTarget({ ...BASE_TARGET, identityFilePath: '/id_rsa' }, {})
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown!.message).not.toContain(fileSecret)
    expect(thrown!.message).toContain('[REDACTED]')
  })
})

// CR-EVM-008/TASK-AG-EVM-011
describe('dialOutboundSshTarget — portForwards', () => {
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        probe.close(() => {
          if (address && typeof address === 'object') {
            resolve(address.port)
          } else {
            reject(new Error('could not determine a free port'))
          }
        })
      })
    })
  }

  it('opens a local listener and calls forwardOut with the declared remote destination on connect', async () => {
    const localPort = await freePort()
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(
      { ...BASE_TARGET, portForwards: [{ localPort, remoteHost: '127.0.0.1', remotePort: 3000 }] },
      { privateKeyPEM: 'k' }
    )
    createdClients[0].nextForwardOutChannel = new PassThrough()
    try {
      const client = createdClients[0]
      const localSocket = net.createConnection({ host: '127.0.0.1', port: localPort })
      await new Promise<void>((resolve, reject) => {
        localSocket.once('connect', () => resolve())
        localSocket.once('error', reject)
      })
      await vi.waitFor(() => {
        if (client.forwardOutCalls.length === 0) {
          throw new Error('forwardOut not called yet')
        }
      })
      expect(client.forwardOutCalls).toEqual([
        { srcIP: '127.0.0.1', srcPort: localPort, dstIP: '127.0.0.1', dstPort: 3000 }
      ])
      localSocket.destroy()
    } finally {
      session.close()
    }
  })

  it('pipes data both ways between the local connection and the forwardOut channel', async () => {
    const localPort = await freePort()
    const echoChannel = new PassThrough()
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(
      { ...BASE_TARGET, portForwards: [{ localPort, remoteHost: '127.0.0.1', remotePort: 3000 }] },
      { privateKeyPEM: 'k' }
    )
    createdClients[0].nextForwardOutChannel = echoChannel
    try {
      const localSocket = net.createConnection({ host: '127.0.0.1', port: localPort })
      await new Promise<void>((resolve, reject) => {
        localSocket.once('connect', () => resolve())
        localSocket.once('error', reject)
      })

      const received = new Promise<string>((resolve) => {
        localSocket.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })
      localSocket.write('hello through the tunnel')

      await expect(received).resolves.toBe('hello through the tunnel')
      localSocket.destroy()
    } finally {
      session.close()
    }
  })

  it('close() stops the local listener — a later connection attempt fails', async () => {
    const localPort = await freePort()
    const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
    resolveNextClientReady()

    const session = await dialOutboundSshTarget(
      { ...BASE_TARGET, portForwards: [{ localPort, remoteHost: '127.0.0.1', remotePort: 3000 }] },
      { privateKeyPEM: 'k' }
    )
    session.close()

    const socket = net.createConnection({ host: '127.0.0.1', port: localPort })
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
    ).rejects.toThrow()
  })

  it('rejects the whole dial when a declared local port is already in use', async () => {
    const localPort = await freePort()
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(localPort, '127.0.0.1', resolve))
    try {
      const { dialOutboundSshTarget } = await import('./ssh-outbound-client')
      resolveNextClientReady()

      await expect(
        dialOutboundSshTarget(
          {
            ...BASE_TARGET,
            portForwards: [{ localPort, remoteHost: '127.0.0.1', remotePort: 3000 }]
          },
          { privateKeyPEM: 'k' }
        )
      ).rejects.toThrow()
      expect(createdClients[0].ended).toBe(true)
    } finally {
      blocker.close()
    }
  })
})
