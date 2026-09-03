import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

describe('mobile Grok reset RPC allowlist', () => {
  it('dispatches the capability-gated Grok reset method for a mobile token', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-grok-reset-'))
    const { runtime, mocks } = createMobileRpcSurfaceRuntime()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const replies: Record<string, unknown>[] = []
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'

    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_consume_grok_reset',
        method: 'accounts.consumeGrokResetCredit',
        deviceToken: mobile.token,
        params: { idempotencyKey }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )

    expect(mocks.consumeGrokRateLimitResetCredit).toHaveBeenCalledWith(idempotencyKey)
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 'req_consume_grok_reset', ok: true })
    )
  })
})
