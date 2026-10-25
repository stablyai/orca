import { beforeEach, describe, expect, it, vi } from 'vitest'

type Request = { method: string; params: Record<string, unknown> | undefined }

type FakeMux = { emit: (method: string, params: Record<string, unknown>) => void }

const fake = vi.hoisted(() => {
  const requests: Request[] = []
  const notifications: Request[] = []
  const instances: FakeMux[] = []
  const requestHandlers = new Map<string, (params?: Record<string, unknown>) => unknown>()
  return {
    requestHandlers,
    requests,
    notifications,
    instances,
    respond: (_method: string, _params: Record<string, unknown> | undefined): unknown => null
  }
})

vi.mock('../ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class {
    private readonly notificationHandlers: ((
      method: string,
      params: Record<string, unknown>
    ) => void)[] = []
    private readonly disposeHandlers: (() => void)[] = []
    private disposed = false
    constructor() {
      fake.instances.push({
        emit: (method, params) => this.notificationHandlers.forEach((h) => h(method, params))
      })
    }
    async request(
      method: string,
      params?: Record<string, unknown>,
      options?: { beforeResolve?: (result: unknown) => void }
    ): Promise<unknown> {
      fake.requests.push({ method, params })
      const result = fake.respond(method, params)
      // Like the real multiplexer: runs as the reply is read, before later frames route.
      options?.beforeResolve?.(result)
      return result
    }
    notify(method: string, params?: Record<string, unknown>): void {
      fake.notifications.push({ method, params })
    }
    onNotification(handler: (method: string, params: Record<string, unknown>) => void) {
      this.notificationHandlers.push(handler)
      return () => {}
    }
    onRequest(method: string, handler: (params?: Record<string, unknown>) => unknown) {
      fake.requestHandlers.set(method, handler)
      return () => {}
    }
    onDispose(handler: () => void) {
      this.disposeHandlers.push(handler)
      return () => {}
    }
    isDisposed(): boolean {
      return this.disposed
    }
    dispose(): void {
      this.disposed = true
      this.disposeHandlers.forEach((handler) => handler())
    }
  }
}))

import {
  LegacyRelayClient,
  LegacyRelayOwnerHeldError,
  REMOTE_CLI_UNAVAILABLE
} from './legacy-relay-client'

const GRANT = {
  protocolVersion: 1,
  serverBuildId: '0.1.0+1.4.224',
  clientGeneration: 1,
  role: 'session-owner',
  ownerGeneration: 3,
  ownerLease: 'lease-a',
  resumed: false
}

function rpcError(code: number): Error {
  return Object.assign(new Error(`relay error ${code}`), { code })
}

const open = (resume: LegacyRelayClient['ownerClaim'] = null) =>
  LegacyRelayClient.open({
    clientInstanceId: 'bridge',
    resume,
    openTransport: async () => ({
      write: () => true,
      onData: () => {},
      onClose: () => {}
    }),
    sleep: async () => {}
  })

beforeEach(() => {
  fake.requests.length = 0
  fake.notifications.length = 0
  fake.instances.length = 0
  fake.respond = () => GRANT
})

describe('the legacy relay client', () => {
  it('asks for the owner role without flow control and accepts any build’s grant', async () => {
    const client = await open()
    expect(client.ownerClaim).toEqual({ ownerGeneration: 3, ownerLease: 'lease-a' })
    const [openClient] = fake.requests
    expect(openClient.method).toBe('pty.openClient')
    expect(openClient.params).toMatchObject({ requestedRole: 'session-owner' })
    expect(openClient.params).not.toHaveProperty('capabilities')
  })

  it('resumes a claim it held before a drop', async () => {
    await open({ ownerGeneration: 3, ownerLease: 'lease-a' })
    expect(fake.requests[0].params).toMatchObject({
      resume: { ownerGeneration: 3, ownerLease: 'lease-a' }
    })
  })

  it('never displaces an attached owner', async () => {
    fake.respond = () => {
      throw rpcError(-32044)
    }
    await expect(open()).rejects.toBeInstanceOf(LegacyRelayOwnerHeldError)
    expect(fake.requests).toHaveLength(1)
  })

  it('waits out a holder that disconnected within its grace', async () => {
    let calls = 0
    fake.respond = () => {
      calls += 1
      if (calls < 3) {
        throw rpcError(-32045)
      }
      return GRANT
    }
    await expect(open()).resolves.toBeInstanceOf(LegacyRelayClient)
    expect(calls).toBe(3)
  })

  it('drops a resume claim the relay no longer knows and asks for a fresh one', async () => {
    let calls = 0
    fake.respond = (_method, params) => {
      calls += 1
      if (params && 'resume' in params) {
        throw rpcError(-32041)
      }
      return GRANT
    }
    await open({ ownerGeneration: 1, ownerLease: 'old' })
    expect(calls).toBe(2)
    expect(fake.requests[1].params).not.toHaveProperty('resume')
  })

  it('talks to a relay that predates owner claims', async () => {
    fake.respond = (method) => {
      if (method === 'pty.openClient') {
        throw rpcError(-32601)
      }
      return null
    }
    await expect(open()).resolves.toMatchObject({ ownerClaim: null })
  })

  it('refuses a grant that is not the owner role', async () => {
    fake.respond = () => ({ ...GRANT, role: 'subscriber' })
    await expect(open()).rejects.toThrow('did not grant the terminal owner role')
  })

  it('lists, attaches with the screen, writes, resizes and routes output and exits', async () => {
    const client = await open()
    fake.respond = (method) =>
      method === 'pty.listProcesses'
        ? [{ id: 'pty-1', cwd: '/srv', title: 'zsh', worktreeId: 'w' }, { nope: true }]
        : { incarnationId: 'i', replay: 'SCREEN' }
    await expect(client.list()).resolves.toEqual([
      { relayPtyId: 'pty-1', cwd: '/srv', title: 'zsh', worktreeId: 'w' }
    ])
    await expect(client.attach('pty-1')).resolves.toEqual({ replay: 'SCREEN' })
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'pty.attach',
      params: { id: 'pty-1', suppressReplayNotification: true, requireReplay: true }
    })
    client.write('pty-1', 'ls\r')
    client.resize('pty-1', 120, 40)
    expect(fake.notifications).toEqual([
      { method: 'pty.data', params: { id: 'pty-1', data: 'ls\r' } },
      { method: 'pty.resize', params: { id: 'pty-1', cols: 120, rows: 40 } }
    ])
    const data: string[] = []
    const exits: number[] = []
    client.onData((id, chunk) => data.push(`${id}:${chunk}`))
    client.onExit((_id, code) => exits.push(code))
    fake.instances[0].emit('pty.data', { id: 'pty-1', data: 'out' })
    fake.instances[0].emit('fs.changed', { path: '/x' })
    fake.instances[0].emit('pty.exit', { id: 'pty-1', code: 0 })
    expect(data).toEqual(['pty-1:out'])
    expect(exits).toEqual([0])
  })

  it('hands an attach’s screen over at the reply, before the call resolves', async () => {
    const client = await open()
    fake.respond = () => ({ incarnationId: 'i', replay: 'SCREEN' })
    const order: string[] = []
    const attached = client.attach('pty-1', (replay) => order.push(`snapshot:${replay}`))
    order.push('returned')
    await attached
    expect(order).toEqual(['snapshot:SCREEN', 'returned'])
  })

  it('answers an orca command from an old terminal with why it is unavailable', async () => {
    await open()
    await expect(fake.requestHandlers.get('orca.cli')?.({})).rejects.toThrow(REMOTE_CLI_UNAVAILABLE)
    await expect(fake.requestHandlers.get('orca.cli.postOutput')?.({})).rejects.toThrow(
      REMOTE_CLI_UNAVAILABLE
    )
  })

  it("hands an old terminal's orca command and its post-output ack to the CLI server", async () => {
    const cli = vi.fn(async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }))
    const postOutput = vi.fn(async () => ({ acknowledged: true }))
    await LegacyRelayClient.open({
      clientInstanceId: 'bridge',
      cliServer: { cli, postOutput },
      openTransport: async () => ({ write: () => true, onData: () => {}, onClose: () => {} })
    })
    const params = { argv: ['orchestration', 'check'], env: { ORCA_TERMINAL_HANDLE: 'term_a' } }
    await expect(fake.requestHandlers.get('orca.cli')?.(params)).resolves.toEqual({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0
    })
    await expect(fake.requestHandlers.get('orca.cli.postOutput')?.(params)).resolves.toEqual({
      acknowledged: true
    })
    expect(cli).toHaveBeenCalledWith(params, expect.any(AbortSignal))
    expect(postOutput).toHaveBeenCalledWith(params, expect.any(AbortSignal))
  })

  it('stops a terminal with the old relay’s own pty.shutdown request', async () => {
    const client = await open()
    fake.respond = () => undefined
    await client.shutdown('pty-1')
    expect(fake.requests.at(-1)).toEqual({
      method: 'pty.shutdown',
      params: { id: 'pty-1', immediate: false, keepHistory: false }
    })
    await client.shutdown('pty-1', 'inc-1')
    expect(fake.requests.at(-1)).toEqual({
      method: 'pty.shutdown',
      params: { id: 'pty-1', immediate: false, keepHistory: false, expectedIncarnationId: 'inc-1' }
    })
  })

  it('hangs up only itself on close', async () => {
    const client = await open()
    const closed = vi.fn()
    client.onClose(closed)
    client.close()
    expect(client.closed).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
    const methods = fake.requests.map((request: Request) => request.method)
    expect(methods).not.toContain('pty.shutdown')
  })
})
