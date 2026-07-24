import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS } from '../../shared/remote-runtime-request-frames'
import { DeviceRegistry } from './device-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { RpcResponse } from './rpc/core'

function createServer(shortRequestCap = 64): OrcaRuntimeRpcServer {
  const runtime = { getRuntimeId: () => 'runtime-test' } as OrcaRuntimeService
  return new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-admission-')),
    shortRequestCap
  })
}

function localRequest(server: OrcaRuntimeRpcServer, id: string): string {
  return JSON.stringify({
    id,
    authToken: server['authToken'],
    method: 'status.get'
  })
}

describe('runtime RPC request admission', () => {
  it('rejects structural amplification before JSON.parse', async () => {
    const server = createServer()
    const amplified = `{"id":"amplified","authToken":"${server['authToken']}","method":"status.get","params":[${'0,'.repeat(REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS.structuralTokens)}0]}`
    const parse = vi.spyOn(JSON, 'parse')

    const response = await server['handleMessage'](amplified)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'bad_request' }
    })
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('caps concurrent short local requests and releases capacity on settle', async () => {
    const server = createServer(1)
    let releaseFirst: ((response: RpcResponse) => void) | undefined
    const firstResponse = new Promise<RpcResponse>((resolve) => {
      releaseFirst = resolve
    })
    const dispatch = vi
      .spyOn(server['dispatcher'], 'dispatch')
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue({
        id: 'after',
        ok: true,
        result: null,
        _meta: { runtimeId: 'runtime-test' }
      })

    const first = server['handleMessage'](localRequest(server, 'first'))
    await vi.waitFor(() => expect(server['activeShortRequests']).toBe(1))

    await expect(server['handleMessage'](localRequest(server, 'overflow'))).resolves.toMatchObject({
      id: 'overflow',
      ok: false,
      error: { code: 'runtime_busy' }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    releaseFirst?.({
      id: 'first',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-test' }
    })
    await first
    expect(server['activeShortRequests']).toBe(0)
    await server['handleMessage'](localRequest(server, 'after'))
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('applies the same short-request cap to WebSocket dispatch', async () => {
    const server = createServer(1)
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-runtime-device-')))
    const device = registry.addDevice('runtime-test', 'runtime')
    server['deviceRegistry'] = registry
    server['activeShortRequests'] = 1
    const replies: RpcResponse[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'overflow', method: 'status.get', deviceToken: device.token }),
      (response) => replies.push(JSON.parse(response) as RpcResponse),
      () => {},
      undefined,
      undefined as WebSocket | undefined
    )

    expect(replies).toEqual([
      expect.objectContaining({
        id: 'overflow',
        ok: false,
        error: expect.objectContaining({ code: 'runtime_busy' })
      })
    ])
  })
})
