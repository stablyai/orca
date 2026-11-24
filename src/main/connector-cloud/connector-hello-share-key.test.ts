// The hello says this machine takes share deliveries, and carries the key held messages are sealed to
// as soon as the RPC server has one, even when the connector said hello before it started (orca serve).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_CLOUD_BOT_SHARES_FEATURE } from '../../shared/connector-cloud-features'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { connectorHello, type ConnectorHelloSaid } from './connector-hello'
import type { ConnectorMachine } from './connector-machine'

const said: ConnectorHelloSaid = { bots: [], paged: false, cut: false, triggers: [] }

function helloOf(hostKey: (() => string | null) | null): Record<string, unknown> {
  const machine: Partial<ConnectorMachine> = {
    runtime: 'serve',
    orcaVersion: '1.0.0',
    hostName: () => 'Mac',
    ...(hostKey
      ? { shareSend: { hostKey, deliver: async () => ({ outcome: 'accepted' as const }) } }
      : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectorHello reads only the fields set above.
  return connectorHello(machine as ConnectorMachine, said).body as Record<string, unknown>
}

describe('the hello and held messages', () => {
  it('lists bots.shares, and a hostKey only once the RPC server has started', async () => {
    const runtime = new OrcaRuntimeService()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hello-share-key-'))
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let refreshes = 0
    runtime.onBotShareHostKeyReady(() => refreshes++)
    const hostKey = () => runtime.botShareDevices?.getE2EEPublicKey() ?? null
    try {
      const before = helloOf(hostKey)
      expect(before.features).toContain(CONNECTOR_CLOUD_BOT_SHARES_FEATURE)
      expect(before).not.toHaveProperty('hostKey')
      await server.start()
      // The connector's hello-inputs listener fires, so it says hello again now, with the key.
      expect(refreshes).toBe(1)
      expect(helloOf(hostKey).hostKey).toBe(server.getE2EEPublicKey())
      expect(helloOf(null)).not.toHaveProperty('hostKey')
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
