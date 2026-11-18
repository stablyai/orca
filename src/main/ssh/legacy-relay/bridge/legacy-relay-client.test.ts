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

vi.mock('../../protocol/ssh-channel-multiplexer', () => ({
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

import { LegacyRelayClient } from './legacy-relay-client'

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
  it('talks to a relay that predates owner claims', async () => {
    fake.respond = (method) => {
      if (method === 'pty.openClient') {
        throw rpcError(-32601)
      }
      return null
    }
    await expect(open()).resolves.toMatchObject({ ownerClaim: null })
  })
})
