import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, type Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { HerdrSshRelayTransport } from './herdr-ssh-relay-transport'
import { HerdrTransport, type HerdrServerRequest } from './herdr-transport'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { SshConnection } from '../../../ssh/ssh-connection'

type SshClient = NonNullable<ReturnType<SshConnection['getClient']>>

function mockSessionManager() {
  return {
    ensureSession: vi.fn(async () => {}),
    run: vi.fn(async () => '/home/testuser\n')
  }
}

describe('HerdrSshRelayTransport', () => {
  let sm: ReturnType<typeof mockSessionManager>

  function makeRelay(stream?: Duplex) {
    const s = stream ?? new PassThrough()
    s.on('error', () => {})

    const sshClient = Object.assign(new EventEmitter(), {
      openssh_forwardOutStreamLocal: vi.fn(
        (_path: string, cb: (err: Error | undefined, stream: Duplex) => void) => {
          cb(undefined, s)
        }
      )
    })

    const connection = {
      getClient: () => sshClient as unknown as SshClient
    } as unknown as SshConnection

    sm = mockSessionManager()
    return new HerdrSshRelayTransport(connection, 5000, async () => 'herdr', undefined, sm as never)
  }

  describe('ensureSession with a responding server', () => {
    it('calls session manager and forwards socket', async () => {
      const r = makeRelay()

      // Simulate server that replies to ping + events.subscribe
      const promise = (async () => {
        await r.ensureSession('orca')
      })()

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (sm.ensureSession.mock.calls.length > 0) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      })

      expect(sm.ensureSession).toHaveBeenCalledWith('orca')
      expect(sm.run).toHaveBeenCalledWith(['sh', '-c', 'echo "$HOME"'])
      promise.catch(() => {})
    })
  })

  it('onEvent registers and returns unsubscribe', () => {
    const r = makeRelay()
    const fn = vi.fn()
    const unsub = r.onEvent(fn)
    expect(unsub).toBeTypeOf('function')
    unsub()
  })

  it('request returns error envelope when not connected', async () => {
    const r = makeRelay()
    const response = await r.request('orca', 'bad.method', {})
    expect('error' in response).toBe(true)
    if ('error' in response) {
      expect(response.error.code).toBe('herdr_request_failed')
    }
  })

  it('controlTerminal throws when not connected', () => {
    const r = makeRelay()
    expect(() => r.controlTerminal('orca', 'p1', { cols: 80, rows: 24 })).toThrow(HerdrRuntimeError)
  })

  it('disconnects cleanly', async () => {
    const r = makeRelay()
    await r.disconnect()
  })
})

describe('HerdrSshRelayTransport with a real transport server (full handshake)', () => {
  let server: HerdrTransport | null = null
  let relay: HerdrSshRelayTransport | null = null

  function makeSshToSocket(socketPath: string) {
    const sm = {
      ensureSession: vi.fn(async () => {}),
      run: vi.fn(async () => '/home/remoteuser\n')
    }

    const sshClient = Object.assign(new EventEmitter(), {
      openssh_forwardOutStreamLocal: vi.fn(
        (_path: string, cb: (err: Error | undefined, stream: Duplex) => void) => {
          const socket = connect(socketPath)
          socket.on('error', () => {})
          socket.on('connect', () => cb(undefined, socket))
        }
      )
    })
    const connection = {
      getClient: () => sshClient as unknown as NonNullable<ReturnType<SshConnection['getClient']>>
    } as unknown as SshConnection

    return { sm, connection }
  }

  async function setupServer(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-relay-test-'))
    const socketPath = join(dir, 'herdr.sock')
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    server.on('request', (request: HerdrServerRequest) => {
      if (request.method === 'ping') {
        request.respond({ type: 'ok' })
        return
      }
      if (request.method === 'events.subscribe') {
        const raw = (request.params as { subscriptions?: { type: string }[] }).subscriptions ?? []
        const kinds = raw.map((sub) => sub.type)
        request.subscribe(kinds)
        request.respond({ type: 'subscription_started' })
        setTimeout(() => {
          server?.notifyEvent('workspace.created', {
            type: 'workspace.created',
            workspace_id: 'w1'
          })
        }, 10)
        return
      }
      if (request.method === 'session.snapshot') {
        request.respond({ snapshot: { protocol: 19, workspaces: [], tabs: [], panes: [] } })
        return
      }
      request.respondError(new Error('unhandled method'))
    })
    await server.startServer()
    return socketPath
  }

  afterEach(async () => {
    await relay?.disconnect()
    relay = null
    await server?.close()
    server = null
  })

  it('completes the ensureSession handshake over the forwarded socket', async () => {
    const socketPath = await setupServer()
    const { sm, connection } = makeSshToSocket(socketPath)
    relay = new HerdrSshRelayTransport(
      connection,
      5000,
      async () => 'herdr',
      undefined,
      sm as never
    )

    await relay.ensureSession('orca')

    expect(sm.ensureSession).toHaveBeenCalledWith('orca')
    expect(sm.run).toHaveBeenCalledWith(['sh', '-c', 'echo "$HOME"'])

    const response = await relay.request<{ snapshot: { protocol: number } }>(
      'orca',
      'session.snapshot',
      {}
    )
    expect('result' in response).toBe(true)
    if ('result' in response) {
      expect((response.result as { snapshot: { protocol: number } }).snapshot.protocol).toBe(19)
    }

    await relay.disconnect()
  })

  it('forwards server-pushed events to onEvent listeners after subscribe', async () => {
    const socketPath = await setupServer()
    const { sm, connection } = makeSshToSocket(socketPath)
    relay = new HerdrSshRelayTransport(
      connection,
      5000,
      async () => 'herdr',
      undefined,
      sm as never
    )

    const events: { event: string; data: Record<string, unknown> }[] = []
    relay.onEvent((event) => events.push(event as never))

    await relay.ensureSession('orca')

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000
      const tick = (): void => {
        if (events.length > 0) {
          resolve()
          return
        }
        if (Date.now() > deadline) {
          reject(new Error('timed out waiting for pushed event'))
          return
        }
        setTimeout(tick, 10)
      }
      tick()
    })

    expect(events[0].event).toBe('workspace.created')
    expect(events[0].data.workspace_id).toBe('w1')

    await relay.disconnect()
  })

  it('reconnects after disconnect by forwarding again', async () => {
    const socketPath = await setupServer()
    const { sm, connection } = makeSshToSocket(socketPath)
    relay = new HerdrSshRelayTransport(
      connection,
      5000,
      async () => 'herdr',
      undefined,
      sm as never
    )

    await relay.ensureSession('orca')
    await relay.disconnect()
    await relay.ensureSession('orca')

    const response = await relay.request('orca', 'ping', {})
    expect('result' in response).toBe(true)
  })
})
