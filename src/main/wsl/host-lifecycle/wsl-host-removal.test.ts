import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import type { WslHostConnector } from './wsl-host-connector-contract'
import { pinnedWslHostLinuxUser, pinWslHostLinuxUsers } from '../orcad/wsl-orcad-host-user'
import { OrcadManagedIdentityError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'

const store = vi.hoisted((): { removed: string[]; pending: string[] } => ({
  removed: [],
  pending: []
}))
// Only the store worker is faked; the removal decision runs for real.
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store', () => ({
  removeWslHostEnvironment: async (_path: string, id: string) => void store.removed.push(id),
  setWslHostPendingStop: async (_path: string, id: string) => void store.pending.push(id)
}))

const { removeWslHostServer } = await import('./wsl-host-removal')

const record: WslHostDeploymentRecord = {
  kind: 'wsl',
  distro: 'Ubuntu-24.04',
  localPort: 41000,
  remotePort: 6800,
  environmentId: 'wsl:ubuntu-24.04',
  createdAt: 1
}

function unreachableConnector(): WslHostConnector & { stopCalls: number } {
  const unused = async (): Promise<never> => {
    throw new Error('not used by Remove')
  }
  const connector: WslHostConnector & { stopCalls: number } = {
    stopCalls: 0,
    listDistros: unused,
    readOrcadPublicKey: unused,
    connect: unused,
    get: () => null,
    isReachable: unused,
    reachability: unused,
    isSettling: () => false,
    resolveDistroName: async () => 'Ubuntu-24.04',
    stopServer: async () => {
      connector.stopCalls += 1
      throw new Error('orcad_identity_mismatch: the server on remote port 6800 is not this host’s')
    },
    disconnect: async () => {},
    releaseHolder: async () => {},
    adoptHolders: async () => {},
    dispose: async () => {}
  }
  return connector
}

// #49180: a host whose server can't be reached must never be stuck listed.
describe('removing a WSL host whose server Orca cannot reach', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-removal-'))
    store.removed = []
    store.pending = []
  })
  afterEach(async () => await removeTempDirs([userDataPath]))

  it('keeps it pending on the first Remove and removes it on the next', async () => {
    const first = await removeWslHostServer(userDataPath, unreachableConnector(), record)
    expect(first.removed).toBe(false)
    expect(store).toEqual({ removed: [], pending: [record.environmentId] })

    const pendingStop = { since: 2, reason: 'mismatch', verdict: 'unverifiable' as const }
    const again = await removeWslHostServer(userDataPath, unreachableConnector(), {
      ...record,
      pendingStop
    })
    expect(again.removed).toBe(true)
    expect(again.serverStop).toMatchObject({ stopped: false, forgotten: true })
    expect(store.removed).toEqual([record.environmentId])
  })

  it('keeps a reachable host whose terminals refused to close, however often it is removed', async () => {
    const connector = unreachableConnector()
    connector.stopServer = async () => ({ stopped: false, verdict: 'live', reason: 'refused' })
    const pendingStop = { since: 2, reason: 'refused', verdict: 'live' as const }
    const again = await removeWslHostServer(userDataPath, connector, { ...record, pendingStop })
    expect(again.removed).toBe(false)
    expect(store.removed).toEqual([])
  })

  it("stops a renamed distro as the record's account, even after a records re-read", async () => {
    const connector = unreachableConnector()
    let stoppedAs: string | undefined
    connector.resolveDistroName = async () => 'Ubuntu-Renamed'
    connector.stopServer = async (distro) => {
      pinWslHostLinuxUsers([])
      stoppedAs = pinnedWslHostLinuxUser(distro)
      return { stopped: true }
    }
    await removeWslHostServer(userDataPath, connector, { ...record, linuxUser: 'root' })
    expect(stoppedAs).toBe('root')
    expect(pinnedWslHostLinuxUser('Ubuntu-Renamed')).toBeUndefined()
  })

  // Its refusal tells the user to remove and re-add; a second Remove must not be needed for that.
  it("removes it on the first Remove once its account's server holds another key", async () => {
    const connector = unreachableConnector()
    connector.stopServer = async () => {
      throw OrcadManagedIdentityError.wslHostKeyChanged(record.distro, 'socket closed (1006)')
    }
    const removal = await removeWslHostServer(userDataPath, connector, {
      ...record,
      linuxUser: 'qauser'
    })
    expect(removal.removed).toBe(true)
    // Removed: the toast must not repeat "remove the WSL host and add it again".
    expect(removal.serverStop).toMatchObject({
      stopped: false,
      forgotten: true,
      reasonCode: 'serverIdentityReset'
    })
    expect(store).toEqual({ removed: [record.environmentId], pending: [] })
  })

  it('keeps an older sealed port refusal pending, as any unproven stop', async () => {
    const connector = unreachableConnector()
    connector.stopServer = async () => {
      throw OrcadManagedIdentityError.foreignPort(6800, 'socket closed (4003)', true)
    }
    const removal = await removeWslHostServer(userDataPath, connector, record)
    expect(removal.removed).toBe(false)
    expect(store.pending).toEqual([record.environmentId])
  })

  it('forgets it without contacting the distro', async () => {
    const connector = unreachableConnector()
    const forgotten = await removeWslHostServer(userDataPath, connector, record, true)
    expect(forgotten.removed).toBe(true)
    expect(connector.stopCalls).toBe(0)
    expect(store.removed).toEqual([record.environmentId])
  })
})
