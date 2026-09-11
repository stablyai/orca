import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'

/**
 * What a phone is told when this desktop has never heard of the method it called.
 *
 * The mobile allowlist gate runs before the dispatcher, so for a mobile-scoped device
 * `method_not_found` is reachable only for a method that IS allowlisted but unregistered.
 * A method an older desktop predates is missing from both, and the phone is told `forbidden`.
 *
 * That distinction is the whole skew contract for a phone probing a method to decide whether the
 * desktop can serve it (`pairing.provisionRelay`, `pairing.getEndpoints`). Keying the "too old,
 * stay on LAN" fallback on `method_not_found` alone never fires against a genuinely old desktop.
 * See docs/reference/remote-wire-compatibility.md — a scope refusal is not a missing method.
 */
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
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    return replies[0] ?? {}
  }

  it('answers forbidden, not method_not_found, for a method this build does not register', async () => {
    const reply = await dispatchAs('mobile', 'pairing.methodThisBuildHasNeverHeardOf')
    expect(reply.ok).toBe(false)
    expect((reply.error as { code?: string }).code).toBe('forbidden')
    expect((reply.error as { code?: string }).code).not.toBe('method_not_found')
  })

  it('answers method_not_found to a non-mobile peer for the same unknown method', async () => {
    const reply = await dispatchAs('runtime', 'pairing.methodThisBuildHasNeverHeardOf')
    expect(reply.ok).toBe(false)
    expect((reply.error as { code?: string }).code).toBe('method_not_found')
  })

  // Why this build's own allowlist and not an older one: a desktop that serves the pairing probes
  // allowlists them, so `forbidden` on either can only come from a build that predates them. That
  // is what makes the phone's fallback a skew contract rather than a local error path.
  it('allowlists both pairing probes, so forbidden on one can only mean an older desktop', () => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('pairing.getEndpoints')).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('pairing.provisionRelay')).toBe(true)
  })
})
