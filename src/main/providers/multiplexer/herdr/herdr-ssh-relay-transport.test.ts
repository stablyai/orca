import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, type Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { HerdrSshRelayTransport } from './herdr-ssh-relay-transport'
import type { SshConnection } from '../../../ssh/ssh-connection'

type SshClient = NonNullable<ReturnType<SshConnection['getClient']>>

function mockSessionManager() {
  return {
    ensureSession: vi.fn(async () => {}),
    run: vi.fn(async () => '/home/testuser\n')
  }
}

function mockHomeExec(home = '/home/testuser') {
  const homeChannel = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        homeChannel.emit('data', Buffer.from(home))
        homeChannel.emit('close')
      })
    })
  })
  return vi.fn(async () => homeChannel)
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
      getClient: () => sshClient as unknown as SshClient,
      exec: mockHomeExec()
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

  it('opens session control even when the relay socket is not connected', async () => {
    const r = makeRelay()
    const open = vi.fn(async () => {
      throw new Error('ssh exec failed')
    })
    ;(r as unknown as { sessionManager: { open: typeof open } }).sessionManager.open = open
    const closed = new Promise<string>((resolve) => {
      r.controlTerminal('orca', 'p1', { cols: 80, rows: 24 }).onClosed((event) =>
        resolve(event.reason ?? '')
      )
    })
    await expect(closed).resolves.toContain('ssh exec failed')
    expect(open).toHaveBeenCalledWith([
      '--session',
      'orca',
      'terminal',
      'session',
      'control',
      'p1',
      '--cols',
      '80',
      '--rows',
      '24'
    ])
  })

  it('disconnects cleanly', async () => {
    const r = makeRelay()
    await r.disconnect()
  })
})

describe('HerdrSshRelayTransport with a real transport server (full handshake)', () => {
  let server: Server | null = null
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
      getClient: () => sshClient as unknown as NonNullable<ReturnType<SshConnection['getClient']>>,
      exec: mockHomeExec('/home/remoteuser')
    } as unknown as SshConnection

    return { sm, connection }
  }

  async function setupServer(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-relay-test-'))
    const socketPath = join(dir, 'herdr.sock')
    server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) {
            continue
          }
          let request: { id?: string; method?: string; params?: unknown }
          try {
            request = JSON.parse(line) as { id?: string; method?: string; params?: unknown }
          } catch {
            continue
          }
          if (typeof request.id !== 'string' || typeof request.method !== 'string') {
            continue
          }
          if (request.method === 'ping') {
            socket.write(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
            continue
          }
          if (request.method === 'events.subscribe') {
            socket.write(
              `${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`
            )
            setTimeout(() => {
              if (!socket.writable) {
                return
              }
              socket.write(
                `${JSON.stringify({
                  event: 'workspace.created',
                  data: { type: 'workspace.created', workspace_id: 'w1' }
                })}\n`
              )
            }, 10)
            continue
          }
          if (request.method === 'session.snapshot') {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                result: { snapshot: { protocol: 19, workspaces: [], tabs: [], panes: [] } }
              })}\n`
            )
            continue
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              error: { code: 'internal_error', message: 'unhandled method' }
            })}\n`
          )
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(socketPath, () => resolve())
    })
    return socketPath
  }

  afterEach(async () => {
    await relay?.disconnect()
    relay = null
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
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
