import { createServer, type Server } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useVouchingSocketOwnerHelper } from '../../browser/network/tunnels/darwin-socket-owner-helper.test-fixture'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../../shared/secure-storage/windows-security-addon'
import type { PairedServerSavedPortForwards } from '../../../shared/remote-runtime/host-catalog/paired-server-saved-port-forwards'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { runtimeHostKeyFingerprint } from '../../ipc/runtime-environments/catalog/runtime-environment-host-key'
import {
  addPairedPortForward,
  closeAllPairedPortForwards,
  configurePairedPortForwards,
  ensurePairedPortForward,
  listPairedPortForwards,
  restorePairedPortForwards
} from './paired-port-forwards'
import { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

function connectionWithHostKey(hostPublicKeyB64: string): PairedRuntimeConnection {
  return {
    endpoint: 'ws://127.0.0.1:9',
    hostPublicKeyB64,
    credential: { kind: 'token', deviceToken: 'device-token' }
  }
}

async function freePort(): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') {
    throw new Error('no port')
  }
  return address.port
}

function configureWithSaved(
  record: PairedServerSavedPortForwards,
  currentHostKey: string
): Map<string, unknown> {
  const saved = new Map<string, unknown>([['env-1', record]])
  configurePairedPortForwards({
    resolveConnection: async () => connectionWithHostKey(currentHostKey),
    onChanged: () => {},
    saved: {
      all: () => Object.fromEntries(saved),
      set: (environmentId, next) => {
        if (next) {
          saved.set(environmentId, next)
        } else {
          saved.delete(environmentId)
        }
      }
    }
  })
  return saved
}

describe('paired port forward restore', () => {
  // On macOS every forward checks its connections' owner through the bundled helper.
  let restoreOwnerHelper = async (): Promise<void> => {}
  beforeAll(async () => {
    restoreOwnerHelper = (await useVouchingSocketOwnerHelper()).restore
  })
  afterAll(() => restoreOwnerHelper())

  afterEach(async () => {
    await closeAllPairedPortForwards()
  })

  it('restores only for the machine the forwards were made for', async () => {
    const localPort = await freePort()
    const record = {
      hostKeyFingerprint: runtimeHostKeyFingerprint('server-key-a'),
      forwards: [{ localPort, remoteHost: 'localhost', remotePort: 5173 }]
    }

    const replaced = configureWithSaved(record, 'server-key-b')
    await restorePairedPortForwards('env-1')
    expect(listPairedPortForwards('env-1')).toEqual([])
    expect(replaced.has('env-1')).toBe(false)

    configureWithSaved(record, 'server-key-a')
    await restorePairedPortForwards('env-1')
    expect(listPairedPortForwards('env-1').map((entry) => entry.localPort)).toEqual([localPort])
  })

  it('never dials a server whose host key changed since the forward started', async () => {
    let dialed = false
    const tunnel = new PairedPortForwardTunnel(
      'env-1',
      runtimeHostKeyFingerprint('server-key-a'),
      async () => {
        dialed = true
        return connectionWithHostKey('server-key-b')
      }
    )
    await expect(tunnel.open({ host: 'localhost', port: 5173 })).rejects.toThrow(
      /paired with another machine/
    )
    expect(dialed).toBe(true)
    tunnel.dispose()
  })

  it('refuses every forward and keeps the saved ones when this computer cannot check accounts', async () => {
    const realPlatform = process.platform
    const port = await freePort()
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      setWindowsSecurityForTests(null)
      const record = {
        hostKeyFingerprint: runtimeHostKeyFingerprint('server-key-a'),
        forwards: [{ localPort: port, remoteHost: 'localhost', remotePort: port }]
      }
      const saved = configureWithSaved(record, 'server-key-a')
      await restorePairedPortForwards('env-1')
      const refused = /can't confirm which account/
      await expect(
        ensurePairedPortForward({ environmentId: 'env-1', remotePort: port })
      ).rejects.toThrow(refused)
      await expect(
        addPairedPortForward({
          environmentId: 'env-1',
          localPort: port,
          remoteHost: 'localhost',
          remotePort: port
        })
      ).rejects.toThrow(refused)
      expect(listPairedPortForwards('env-1')).toEqual([])
      expect(saved.get('env-1')).toEqual(record)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
      resetWindowsSecurityLoadForTests()
    }
  })
})
