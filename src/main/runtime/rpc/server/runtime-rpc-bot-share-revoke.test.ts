// Removing a teammate from a shared bot must end every device of theirs on it at once.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')

describe('revoking a teammate’s share devices', () => {
  it('removes their desktop and the phone under it, closes both, and keeps everyone else', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-share-revoke-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    try {
      const shares = server.getBotShareDevices()!
      const terminate = vi.spyOn(server.getMobileSocketWiring()!, 'terminateDeviceConnections')
      const grant = { botId: 'bot-1', accountId: 'acct-alice', name: 'Alice' }
      const desktop = await shares.add({ ...grant, scope: 'runtime', devicePublicKeyB64: key() })
      const phone = await shares.add({
        ...grant,
        scope: 'mobile',
        devicePublicKeyB64: key(),
        parentDeviceId: desktop.deviceId
      })
      const binding = {
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId: desktop.deviceId,
        ownerIdentityKey: 'owner'
      }
      await shares.setRelayBinding(desktop.deviceId, binding)
      const bob = await shares.add({
        ...grant,
        accountId: 'acct-bob',
        name: 'Bob',
        scope: 'runtime',
        devicePublicKeyB64: key()
      })
      const otherBot = await shares.add({
        ...grant,
        botId: 'bot-2',
        scope: 'runtime',
        devicePublicKeyB64: key()
      })

      expect(await server.revokeBotShareDevices('bot-1', 'acct-alice')).toBe(true)

      expect(shares.list().map((device) => device.deviceId)).toEqual([
        bob.deviceId,
        otherBot.deviceId
      ])
      expect(terminate.mock.calls.map(([deviceId]) => deviceId)).toEqual([
        phone.deviceId,
        desktop.deviceId
      ])
      // Relay forgets the desktop's resume credential, even while it can't be reached.
      expect(
        server
          .getRelayRevokeOutbox()
          .pendingFor(binding.ownerIdentityKey, binding.relayHostId)
          .map((item) => item.relayDeviceId)
      ).toEqual([desktop.deviceId])
      // Durable: a restart reads the same rows back.
      await server.stop()
      await server.start()
      expect(
        server
          .getBotShareDevices()!
          .list()
          .map((device) => device.deviceId)
      ).toEqual([bob.deviceId, otherBot.deviceId])
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
