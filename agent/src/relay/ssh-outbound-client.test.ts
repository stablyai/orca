// src/relay/ssh-outbound-client.test.ts
// TASK-AG-EVM-005: dialOutboundSshTarget — real dial via mocked ssh2.Client,
// jumpHost double-hop, proxyCommand spawn+Duplex wrapping, and the security
// regression-guard (privateKeyPEM must never surface in a thrown error).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
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

beforeEach(() => {
  createdClients.length = 0
  lastSpawnArgs = null
  lastSpawnedChild = null
  vi.clearAllMocks()
})

const BASE_TARGET: EphemeralVmRecipeSshTarget = {
  label: 'vm-1',
  host: 'vm1.example.com',
  port: 2222,
  username: 'deploy'
}

// Fires 'ready' on the most-recently-created FakeSsh2Client on next microtask
// (mirrors ssh2's real async connect behavior enough for these unit tests).
function resolveNextClientReady(): void {
  queueMicrotask(() => {
    const client = createdClients.at(-1)
    client?.emit('ready')
  })
}

function rejectNextClientWithError(err: Error): void {
  queueMicrotask(() => {
    const client = createdClients.at(-1)
    client?.emit('error', err)
  })
}

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
})
