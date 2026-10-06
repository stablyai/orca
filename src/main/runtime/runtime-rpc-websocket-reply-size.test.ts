import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { defineMethod } from './rpc/core'
import { RPC_REPLY_TOO_LARGE_CODE } from './rpc/dispatcher-reply-size-guard'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

describe('OrcaRuntimeRpcServer WebSocket reply size', () => {
  it('answers an oversized reply with a correlated error instead of the frame', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub method reaches only the runtime id.
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime'
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: false,
      methods: [
        defineMethod({
          name: 'test.big',
          params: null,
          handler: () => 'x'.repeat(4.5 * 1024 * 1024)
        })
      ]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('desktop', 'runtime')
    const replies: string[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'big-1', method: 'test.big' }),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      device.token
    )

    expect(replies).toHaveLength(1)
    expect(JSON.parse(replies[0]!)).toMatchObject({
      id: 'big-1',
      ok: false,
      error: { code: RPC_REPLY_TOO_LARGE_CODE }
    })
  })
})
