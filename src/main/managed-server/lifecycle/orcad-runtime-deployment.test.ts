import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { getOrcadSshDeployment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  listEnvironments,
  resolveEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/remote-runtime/ssh/managed-orcad-ssh-owner'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { Store } from '../../persistence/loading-store/store'
import { SshConnectionStore } from '../../ssh/targets/ssh-connection-store'
import {
  setSshConnectionManagerResolver,
  setSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { createManagedOrcadEnvironment } from './orcad-runtime-deployment'

const host = vi.hoisted(() => ({ publicKeyB64: '', localPort: 0 }))
const THIS_MACHINE = Buffer.alloc(32, 7).toString('base64')
const OTHER_MACHINE = Buffer.alloc(32, 9).toString('base64')

vi.mock('../../orcad/artifact-slots/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/orcad-artifact'
}))
vi.mock('../install/remote-versioned-install', () => ({ readLocalFullVersion: () => 'v1' }))
vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: async () => ({ activationRecord: { active: 'v1' }, serverTarget: {} })
}))
vi.mock('../activation/orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: async () => ({ outcome: 'none' })
}))
vi.mock('../activation/orcad-running-version-adoption', () => {
  const readiness = () => ({
    runtimeId: 'runtime-1',
    boundEndpoint: null,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768/runtime',
        publicKeyB64: host.publicKeyB64,
        deviceToken: `startup-offer-${host.localPort}`,
        pairedDeviceId: 'desktop'
      })
    }
  })
  return {
    adoptRunningOrcadVersion: async () => ({
      version: 'v1',
      readiness: readiness(),
      reprobe: async () => readiness()
    })
  }
})
vi.mock('./orcad-managed-tunnel', () => ({
  startOrcadManagedTunnel: async () => host.localPort,
  closeOrcadManagedTunnel: async () => undefined,
  ensureOrcadManagedTunnel: (userDataPath: string, id: string) =>
    resolveEnvironment(userDataPath, id)
}))
vi.mock('../../ipc/ssh/ssh-session-teardown', () => ({
  releaseUnlinkedHostTransport: async () => undefined
}))

const directories: string[] = []
afterEach(async () => {
  setSshTargetRegistryStore(null)
  setSshConnectionManagerResolver(null)
  await closeTestStores()
  await removeTempDirs(directories.splice(0))
})

function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-deployment-'))
  directories.push(userDataPath)
  const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  for (const [id, label] of [
    ['ssh-lan', 'dell'],
    ['ssh-wan', 'dell-remote'],
    ['ssh-other', 'other']
  ]) {
    store.addSshTarget({ id, label, host: label, port: 22, username: 'user' })
  }
  setSshTargetRegistryStore(new SshConnectionStore(store))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deploy calls only connect, and the faked remote host ignores its connection.
  const connectionManager = { connect: async () => ({}) } as unknown as SshConnectionManager
  setSshConnectionManagerResolver(() => connectionManager)
  const deploy = async (args: {
    sshTargetId: string
    localPort: number
    publicKeyB64?: string
    name?: string
  }) => {
    host.publicKeyB64 = args.publicKeyB64 ?? THIS_MACHINE
    host.localPort = args.localPort
    const result = await createManagedOrcadEnvironment(userDataPath, {
      name: args.name ?? store.getSshTarget(args.sshTargetId)!.label,
      sshTargetId: args.sshTargetId
    })
    if (result.outcome === 'deferred') {
      throw new Error(result.reason)
    }
    return result.environment.id
  }
  const saved = async () =>
    (await listEnvironments(userDataPath)).map((entry) => ({
      id: entry.id,
      name: entry.name,
      sshTargetId: getOrcadSshDeployment(entry)?.sshTargetId,
      localPort: getOrcadSshDeployment(entry)?.localPort,
      deviceToken: entry.endpoints[0]?.deviceToken
    }))
  const fence = (sshTargetId: string) =>
    getManagedOrcadFenceEnvironmentId(store.getSshTarget(sshTargetId))
  return { store, deploy, saved, fence }
}

describe('createManagedOrcadEnvironment', () => {
  it('keeps one saved server as its machine is deployed from one SSH host, the other, and back', async () => {
    const { store, deploy, saved, fence } = setup()
    const id = await deploy({ sshTargetId: 'ssh-lan', localPort: 41000 })
    const original = { id, name: 'dell', localPort: 41000, deviceToken: 'startup-offer-41000' }

    expect(await deploy({ sshTargetId: 'ssh-wan', localPort: 41001 })).toBe(id)
    expect(await saved()).toEqual([{ ...original, sshTargetId: 'ssh-wan' }])
    expect([fence('ssh-lan'), fence('ssh-wan')]).toEqual([null, id])
    expect(store.getSshTarget('ssh-lan')?.managedServerRemoved).toBeDefined()

    expect(await deploy({ sshTargetId: 'ssh-lan', localPort: 41002 })).toBe(id)
    expect(await saved()).toEqual([{ ...original, sshTargetId: 'ssh-lan' }])
    expect([fence('ssh-lan'), fence('ssh-wan')]).toEqual([id, null])
    expect(store.getSshTarget('ssh-wan')?.managedServerRemoved).toBeDefined()
  })

  it('saves another machine as its own server', async () => {
    const { deploy, saved } = setup()
    await deploy({ sshTargetId: 'ssh-lan', localPort: 41000 })
    await deploy({ sshTargetId: 'ssh-other', localPort: 41001, publicKeyB64: OTHER_MACHINE })

    expect((await saved()).map((entry) => [entry.name, entry.sshTargetId])).toEqual([
      ['dell', 'ssh-lan'],
      ['other', 'ssh-other']
    ])
  })

  it('refuses another machine under the name of a saved server and leaves its SSH host unclaimed', async () => {
    const { store, deploy, saved, fence } = setup()
    await deploy({ sshTargetId: 'ssh-lan', localPort: 41000 })

    await expect(
      deploy({
        sshTargetId: 'ssh-other',
        localPort: 41001,
        publicKeyB64: OTHER_MACHINE,
        name: 'dell'
      })
    ).rejects.toThrow('A server named "dell" already exists.')
    expect((await saved()).map((entry) => entry.sshTargetId)).toEqual(['ssh-lan'])
    expect(fence('ssh-other')).toBeNull()
    expect(store.getSshTarget('ssh-other')?.orcadProvisioning).toBeUndefined()
  })
})
