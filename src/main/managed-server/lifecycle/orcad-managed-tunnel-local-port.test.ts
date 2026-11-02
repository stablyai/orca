import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../../shared/runtime-environment-managed-orcad-store'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getRuntimeSshAccess } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import { reserveLocalForwardPort } from '../../ssh/system-transport/system-ssh-forward-port-reservation'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import { buildOnBindableLocalPort } from './orcad-managed-tunnel-local-port'
import { setManagedOrcadPairingRepairedListener } from './orcad-managed-pairing-repaired-listener'

function listen(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function portOf(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('listener has no port')
  }
  return address.port
}

describe('managed tunnel on an unbindable saved local port', () => {
  let userDataPath: string
  let occupied: Server
  let savedPort: number

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-tunnel-port-'))
    // Stands in for a Windows excluded range or another app's listener on the saved port.
    occupied = await listen()
    savedPort = portOf(occupied)
    addManagedOrcadEnvironment(userDataPath, {
      id: 'environment-1',
      name: 'Builder',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: `ws://127.0.0.1:${savedPort}`,
        deviceToken: 'device-token',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
        pairedDeviceId: 'device-1'
      }),
      orcadDeployment: {
        sshTargetId: 'ssh-1',
        sshTargetGeneration: 7,
        localPort: savedPort,
        remotePort: 6_768
      },
      now: 100
    })
  })

  afterEach(async () => {
    setManagedOrcadPairingRepairedListener(() => {})
    await new Promise((resolve) => occupied.close(resolve))
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function setup(bindError?: Error, connectDelayMs = 0) {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Builder',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      generation: 7,
      orcadFence: { environmentId: 'environment-1' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
    const connection = { getConnectGeneration: () => 1 } as unknown as SshConnection
    const addForward = vi.fn(
      async (connectionId: string, _conn: SshConnection, localPort: number) => {
        if (bindError && localPort === savedPort) {
          throw bindError
        }
        // The real transport reserves fixed ports before it forwards.
        await reserveLocalForwardPort(localPort)
        return {
          id: `forward-${localPort}`,
          connectionId,
          localPort,
          remoteHost: '',
          remotePort: 1
        }
      }
    )
    const manager = new OrcadManagedTunnelManager({
      getConnectionManager: () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only connect.
        ({
          connect: async () => {
            await new Promise((resolve) => setTimeout(resolve, connectDelayMs))
            return connection
          }
        }) as unknown as SshConnectionManager,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only getTarget.
      getTargetStore: () => ({ getTarget: () => target }) as unknown as SshConnectionStore,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
      forwardManager: {
        setCallbacks: vi.fn(),
        addForward,
        removeForwardAndWait: vi.fn(),
        dispose: vi.fn()
      } as unknown as SshPortForwardManager,
      ensureServing: vi.fn().mockResolvedValue({ state: 'serving' })
    })
    const resolve = () => resolveEnvironment(userDataPath, 'environment-1')
    const retired = vi.fn()
    setManagedOrcadPairingRepairedListener(retired)
    const ensure = () =>
      buildOnBindableLocalPort(userDataPath, 'environment-1', () =>
        manager.ensure(resolve(), resolve)
      )
    return { addForward, ensure, resolve, retired }
  }

  it.each([
    ['held by another listener', undefined],
    [
      'in a Windows excluded range',
      new Error('Local port is not available: listen EACCES', { cause: 'EACCES' })
    ]
  ])('moves to a free port and saves it with the same pairing when %s', async (_case, error) => {
    const { addForward, ensure, resolve, retired } = setup(error)
    const before = resolve()

    await ensure()

    const moved = resolve()
    const movedPort = getRuntimeSshAccess(moved)?.localPort
    expect(movedPort).not.toBe(savedPort)
    expect(addForward).toHaveBeenLastCalledWith(
      'ssh-1',
      expect.anything(),
      movedPort,
      '127.0.0.1',
      6_768,
      'Orca on Builder'
    )
    expect(moved.endpoints[0]?.endpoint).toBe(`ws://127.0.0.1:${movedPort}/`)
    expect(moved.endpoints[0]?.deviceToken).toBe(before.endpoints[0]?.deviceToken)
    expect(moved.endpoints[0]?.publicKeyB64).toBe(before.endpoints[0]?.publicKeyB64)
    expect(moved.pairedDeviceId).toBe('device-1')
    expect(moved.runtimeId).toBe(before.runtimeId)
    expect(moved.pairingRevision).toBeGreaterThan(before.pairingRevision ?? 0)
    expect(getRuntimeSshAccess(moved)?.remotePort).toBe(6_768)
    // Status owners and transports still dialing the old port are retired, as after a repair.
    expect(retired).toHaveBeenCalledWith('environment-1')
  })

  it('moves once and lets every concurrent caller build on the moved port', async () => {
    const { ensure, resolve, retired } = setup(undefined, 50)

    await expect(Promise.all([ensure(), ensure(), ensure()])).resolves.toHaveLength(3)

    expect(getRuntimeSshAccess(resolve())?.localPort).not.toBe(savedPort)
    expect(retired).toHaveBeenCalledOnce()
  })

  it('keeps the saved port when the bind fails for another reason', async () => {
    const { ensure, resolve, retired } = setup(new Error('ssh exited', { cause: 'ECONNRESET' }))

    await expect(ensure()).rejects.toThrow('ssh exited')

    expect(getRuntimeSshAccess(resolve())?.localPort).toBe(savedPort)
    expect(retired).not.toHaveBeenCalled()
  })
})
