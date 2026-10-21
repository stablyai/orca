import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

describe('a server-targeted phone call on a legacy (non-E2EE) socket', () => {
  it('is refused, never run on this desktop', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-legacy-relay-'))
    const { runtime, mocks } = createMobileRpcSurfaceRuntime()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const replies: Record<string, unknown>[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_1',
        method: 'terminal.read',
        executionHost: 'runtime:env-1',
        deviceToken: device.token,
        params: { terminal: 'terminal-1' }
      }),
      (response) => {
        const parsed: Record<string, unknown> = JSON.parse(response)
        replies.push(parsed)
      },
      () => {}
    )
    expect(mocks.readTerminal).not.toHaveBeenCalled()
    expect(replies).toMatchObject([
      {
        ok: false,
        error: {
          code: 'remote_runtime_unavailable',
          message: 'Servers are reachable only over an encrypted pairing'
        }
      }
    ])
  })
})
