import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../../shared/secure-storage/windows-security-addon'
import { runtimeHostKeyFingerprint } from '../../ipc/runtime-environments/catalog/runtime-environment-host-key'
import {
  closeAllPairedPortForwards,
  configurePairedPortForwards,
  restorePairedPortForwards
} from './paired-port-forwards'

// #49185: a computer that can't check who connects refused each saved forward only after probing
// its ports, and an addon error naming EACCES walked every candidate port. Restore must check once
// and probe nothing.
describe('paired forward restore without a connection owner lookup', () => {
  const realPlatform = process.platform
  const servers: Server[] = []
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    resetWindowsSecurityLoadForTests()
    await closeAllPairedPortForwards()
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  })

  it.each([5, 50])('probes no port for %i saved forwards', async (n) => {
    let probes = 0
    const ports = await Promise.all(
      Array.from({ length: n }, async () => {
        const server = createServer((socket) => {
          probes++
          socket.destroy()
        })
        servers.push(server)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        return typeof address === 'object' && address ? address.port : 0
      })
    )
    Object.defineProperty(process, 'platform', { value: 'win32' })
    setWindowsSecurityForTests(null, "EACCES: permission denied, open 'orca_windows_security.node'")
    const record = {
      hostKeyFingerprint: runtimeHostKeyFingerprint('server-key'),
      forwards: ports.map((port) => ({
        localPort: port,
        remoteHost: 'localhost',
        remotePort: port
      }))
    }
    configurePairedPortForwards({
      resolveConnection: async () => ({
        endpoint: 'ws://127.0.0.1:9',
        hostPublicKeyB64: 'server-key',
        credential: { kind: 'token', deviceToken: 'device-token' }
      }),
      onChanged: () => {},
      saved: { all: () => ({ 'env-1': record }), set: () => {} }
    })
    await restorePairedPortForwards('env-1')
    expect(probes).toBe(0)
  })
})
