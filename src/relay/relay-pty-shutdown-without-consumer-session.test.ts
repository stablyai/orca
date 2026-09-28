import './mock-descendant-sweep'
// The client's maintenance channel ends a disconnected host's terminals from a bare connection: it
// never opens a consumer session and never reattaches. This pins that the host honours that stop,
// and that the opt-in owner fence still refuses a caller the host never attested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { PtyHandler } from './pty-handler'
import { TEST_PTY_ID_MINT_EPOCH } from './pty-handler-test-harness'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const { mockPtySpawn } = vi.hoisted(() => ({ mockPtySpawn: vi.fn() }))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

const PANE_KEY = 'tab-agent:22222222-2222-4222-8222-222222222222'

// Mirrors what relay-reconnect-listener attaches for a socket client that proved the credential.
const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'relay-endpoint:build-a',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

type RpcMessage = { id?: number; result?: unknown; error?: { message: string } }

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function decode(buffer: Buffer): RpcMessage | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
}

function idOf(value: unknown): string {
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id
  }
  throw new Error(`Expected a PTY entry, got ${JSON.stringify(value)}`)
}

describe('relay pty.shutdown from a client that never opened a consumer session', () => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let killPty: ReturnType<typeof vi.fn>
  let originalPlatform: PropertyDescriptor | undefined
  let nextRequestId = 100

  function attach(): { clientId: number; writes: Buffer[] } {
    const writes: Buffer[] = []
    const clientId = dispatcher.attachClient(
      (data, settle) => {
        writes.push(Buffer.from(data))
        queueMicrotask(() => settle({ ok: true }))
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    return { clientId, writes }
  }

  async function call(
    client: { clientId: number; writes: Buffer[] },
    method: string,
    params: Record<string, unknown>
  ): Promise<RpcMessage> {
    const id = nextRequestId++
    dispatcher.feedClient(client.clientId, requestFrame(id, method, params))
    for (let turn = 0; turn < 20; turn++) {
      await vi.advanceTimersByTimeAsync(0)
      const reply = client.writes.map(decode).find((message) => message?.id === id)
      if (reply) {
        return reply
      }
    }
    throw new Error(`No reply to ${method}`)
  }

  async function listedIds(client: { clientId: number; writes: Buffer[] }): Promise<string[]> {
    // Why no evidence: the foreground-process capture reads the real process table.
    const reply = await call(client, 'pty.listProcesses', {
      includeForegroundProcessEvidence: false
    })
    expect(Array.isArray(reply.result)).toBe(true)
    return (Array.isArray(reply.result) ? reply.result : []).map(idOf)
  }

  // The session owner the maintenance channel stands in for: it opens a consumer session, spawns a
  // pane shell, then goes away, as a user's Disconnect leaves it.
  async function spawnFromOwnerThenDisconnect(): Promise<string> {
    const owner = attach()
    const grant = await call(owner, 'pty.openClient', {
      protocolVersion: 1,
      clientInstanceId: 'client-1',
      requestedRole: 'session-owner',
      capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
    })
    expect(grant.error).toBeUndefined()
    const spawned = await call(owner, 'pty.spawn', { env: { ORCA_PANE_KEY: PANE_KEY } })
    expect(spawned.error).toBeUndefined()
    const id = idOf(spawned.result)
    dispatcher.detachClient(owner.clientId, 'peer-closed')
    await vi.advanceTimersByTimeAsync(0)
    return id
  }

  beforeEach(() => {
    vi.useFakeTimers()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    let exitCallback: ((event: { exitCode: number }) => void) | undefined
    // Why deferred: node-pty reports the exit on a later turn, never inside kill().
    killPty = vi.fn(() => setTimeout(() => exitCallback?.({ exitCode: 137 }), 0))
    mockPtySpawn.mockReset()
    mockPtySpawn.mockReturnValue({
      pid: process.pid,
      onData: vi.fn(),
      onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
        exitCallback = callback
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killPty,
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn()
    })
    // The launch channel's sink, as RelayPrimaryChannel builds it; the owner and the maintenance
    // channel both arrive as socket clients.
    dispatcher = new RelayDispatcher(
      (_data, settle) => {
        queueMicrotask(() => settle({ ok: true }))
        return true
      },
      { supportsWriteCallback: true }
    )
    handler = new PtyHandler(dispatcher, undefined, TEST_PTY_ID_MINT_EPOCH)
    // Wired exactly as RelayRuntimeServices wires them.
    const adapter = new SshPtyConsumerSessionAdapter(
      dispatcher,
      'build-a',
      (id, paused) => handler.setConsumerDeliveryPaused(id, paused),
      (id) => handler.handleSourceCreditAvailable(id)
    )
    handler.setConsumerIdentityResolver((clientId) => adapter.clientInstanceIdFor(clientId))
    handler.setSourcePublication(
      new RelayPtySourcePublication(dispatcher, adapter, (id) =>
        handler.handleSourcePublicationCapacity(id)
      )
    )
  })

  afterEach(async () => {
    await handler.dispose({ waitForPhysicalExit: false }).catch(() => {})
    dispatcher.dispose()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    vi.useRealTimers()
  })

  it('kills the PTY an absent owner spawned', async () => {
    const id = await spawnFromOwnerThenDisconnect()
    const maintenance = attach()
    expect(await listedIds(maintenance)).toContain(id)

    const reply = await call(maintenance, 'pty.shutdown', {
      id,
      immediate: true,
      keepHistory: false
    })

    expect(reply.error).toBeUndefined()
    expect(killPty).toHaveBeenCalledWith('SIGKILL')
    expect(await listedIds(maintenance)).not.toContain(id)
  })

  it('still refuses an owner-fenced stop from a connection that holds no grant', async () => {
    const id = await spawnFromOwnerThenDisconnect()
    const maintenance = attach()

    const reply = await call(maintenance, 'pty.shutdown', {
      id,
      immediate: true,
      keepHistory: false,
      expectedOwnerClientInstanceId: 'client-1'
    })

    expect(reply.error?.message).toContain('requester is not the attested owner')
    expect(killPty).not.toHaveBeenCalled()
    expect(await listedIds(maintenance)).toContain(id)
  })
})
