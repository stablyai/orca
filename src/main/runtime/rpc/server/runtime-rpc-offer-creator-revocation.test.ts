// A paired client with a terminal can run `orca pair`; revoking that client must take the link it minted.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

describe('revoking a paired client', () => {
  it('revokes the links minted from its terminal, used or not, and keeps the owner’s', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-offer-creator-revoke-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    try {
      const offer = (args: { name: string; createdByDeviceId?: string }) => {
        const made = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime', ...args })
        if (!made.available) {
          throw new Error('WebSocket pairing unavailable')
        }
        return { deviceId: made.deviceId, token: parsePairingCode(made.pairingUrl)!.deviceToken }
      }
      const registry = server.getDeviceRegistry()!
      const teammate = offer({ name: 'Teammate' })
      registry.updateLastSeen(teammate.deviceId)
      const minted = offer({ name: 'Minted', createdByDeviceId: teammate.deviceId })
      registry.updateLastSeen(minted.deviceId)
      const unscanned = offer({ name: 'Unscanned', createdByDeviceId: teammate.deviceId })
      const owners = offer({ name: 'Owner' })

      // The owner's request never reuses a link the teammate minted.
      expect(unscanned.deviceId).not.toBe(owners.deviceId)
      expect(server.revokeRuntimeAccess(teammate.deviceId)).toBe(true)

      expect(registry.validateToken(minted.token)).toBeNull()
      expect(registry.validateToken(unscanned.token)).toBeNull()
      expect(registry.validateToken(owners.token)?.deviceId).toBe(owners.deviceId)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
