import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'

/** Older hosts lack both registration and mobile allowlist entry, so unknown mobile probes return forbidden; method_not_found requires an allowlisted method.
 * Phone skew fallback must handle scope refusal too (pairing.provisionRelay/getEndpoints; docs/reference/remote-wire-compatibility.md). */
function errorCode(reply: Record<string, unknown>): string | undefined {
  const error = reply.error
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  return typeof error.code === 'string' ? error.code : undefined
}

describe('an unknown method reaching a mobile-scoped device', () => {
  const dispatchAs = async (
    scope: 'mobile' | 'runtime',
    method: string
  ): Promise<Record<string, unknown>> => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-scope-'))
    const { runtime } = createMobileRpcSurfaceRuntime()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('peer', scope)
    const replies: Record<string, unknown>[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'req_1', method, deviceToken: device.token, params: {} }),
      (response) => {
        const parsed: Record<string, unknown> = JSON.parse(response)
        replies.push(parsed)
      },
      () => {}
    )
    return replies[0] ?? {}
  }

  it('answers forbidden, not method_not_found, for a method this build does not register', async () => {
    const reply = await dispatchAs('mobile', 'pairing.methodThisBuildHasNeverHeardOf')
    expect(reply.ok).toBe(false)
    expect(errorCode(reply)).toBe('forbidden')
    expect(errorCode(reply)).not.toBe('method_not_found')
  })

  it('answers method_not_found to a non-mobile peer for the same unknown method', async () => {
    const reply = await dispatchAs('runtime', 'pairing.methodThisBuildHasNeverHeardOf')
    expect(reply.ok).toBe(false)
    expect(errorCode(reply)).toBe('method_not_found')
  })

  // Current hosts allowlist supported pairing probes; forbidden identifies a host predating them for skew fallback.
  it('allowlists both pairing probes, so forbidden on one can only mean an older desktop', () => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('pairing.getEndpoints')).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('pairing.provisionRelay')).toBe(true)
  })
})
