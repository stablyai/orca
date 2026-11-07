// #36923: waking a recipe VM re-pairs its server, so the CLI must send with the new pairing.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(async (): Promise<'unchanged' | 'reload'> => 'unchanged'),
  resolveConnection: vi.fn(() => ({
    endpoint: 'wss://vm-after-wake',
    hostPublicKeyB64: 'key',
    credential: { kind: 'token', deviceToken: 'token' }
  }))
}))

vi.mock('./recipe-vm-wake-gate', () => ({ prepareRecipeVmEnvironmentCall: mocks.prepare }))
vi.mock('./runtime-remote-pairing', () => ({ resolveRemoteConnection: mocks.resolveConnection }))

import { RemoteRuntimeCompatGate } from './remote-runtime-compat-gate'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'

type Transport = Parameters<RemoteRuntimeCompatGate['send']>[0]['transport']
const OK = { id: '1', ok: true as const, result: {}, _meta: { runtimeId: 'vm' } }

function transport() {
  const sendWebSocketRequest = vi.fn(
    async (_connection: PairedRuntimeConnection, ..._rest: unknown[]) => OK
  )
  const sendWebSocketRequestWithStatusPreflight = vi.fn(async (..._args: unknown[]) => OK)
  const senders = { sendWebSocketRequest, sendWebSocketRequestWithStatusPreflight }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both senders answer every request with OK, which fits whatever result type the gate asks for.
  return { typed: senders as unknown as Transport, sendWebSocketRequest }
}

function connection(endpoint: string): PairedRuntimeConnection {
  return { endpoint, hostPublicKeyB64: 'key', credential: { kind: 'token', deviceToken: 'token' } }
}

const BEFORE = connection('wss://vm-before-sleep')

describe('a CLI request to a recipe VM environment', () => {
  beforeEach(() => {
    mocks.prepare.mockClear()
    mocks.resolveConnection.mockClear()
  })

  it('sends with the pairing the wake saved, for this and later requests', async () => {
    const gate = new RemoteRuntimeCompatGate('/user-data', 'sandbox')
    const sender = transport()
    mocks.prepare.mockResolvedValueOnce('reload')
    const send = (method: string) =>
      gate.send({
        transport: sender.typed,
        connection: BEFORE,
        method,
        params: {},
        timeoutMs: 1000
      })

    await send('status.get')
    await send('status.get')

    expect(mocks.prepare).toHaveBeenCalledWith('/user-data', 'sandbox', 'status.get')
    expect(sender.sendWebSocketRequest.mock.calls.map(([sent]) => sent.endpoint)).toEqual([
      'wss://vm-after-wake',
      'wss://vm-after-wake'
    ])
  })

  it('keeps the connection it was given while the VM is awake', async () => {
    const gate = new RemoteRuntimeCompatGate('/user-data', 'sandbox')
    const sender = transport()
    await gate.send({
      transport: sender.typed,
      connection: BEFORE,
      method: 'status.get',
      params: {},
      timeoutMs: 1000
    })
    expect(mocks.resolveConnection).not.toHaveBeenCalled()
    expect(sender.sendWebSocketRequest.mock.calls[0]?.[0]).toBe(BEFORE)
  })
})
