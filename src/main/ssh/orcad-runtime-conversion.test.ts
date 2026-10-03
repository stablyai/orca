import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { SshConnectionStore } from './ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn(), directAuthority: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: mocks.directAuthority
}))
vi.mock('./orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.ensureTunnel }))

const { convertSshTargetToManagedOrcad } = await import('./orcad-runtime-conversion')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

let userDataPath: string
let store: Store
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-conversion-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
  destination = fakeOrcadMigrationDestination()
  mocks.directAuthority.mockReturnValue(false)
  mocks.ensureTunnel.mockResolvedValue(undefined)
  // Registers the server the fence named, as the real deploy would after pairing.
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))
    if (!owner) {
      throw new Error('deploy without a fence')
    }
    if (!listEnvironments(path).some((entry) => entry.id === owner)) {
      addManagedOrcadEnvironment(path, {
        id: owner,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        orcadDeployment: {
          sshTargetId: TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    return { outcome: 'created', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const releaseDirectSession = vi.fn(async () => {})
let retireSource = true
const convert = (listRelayPtyIds: (() => Promise<string[] | null>) | null = async () => []) =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId: TARGET.id,
    name: 'Managed',
    listRelayPtyIds,
    destinationFor: () => destination,
    releaseDirectSession,
    now: () => new Date('2026-10-02T00:00:00.000Z'),
    retireSource: () => retireSource
  })

describe('converting an SSH host into a managed server', () => {
  it('fences, deploys, marks the server, commits once, then retires the source', async () => {
    const result = await convert()
    expect(result).toMatchObject({ outcome: 'converted' })
    expect(releaseDirectSession).toHaveBeenCalledWith(TARGET.id)
    expect(mocks.deploy).toHaveBeenCalledWith(
      userDataPath,
      expect.objectContaining({ migration: true })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.orcadMigratedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(destination.commits).toBe(1)
    expect(store.getRepos()).toEqual([])
    // The journal compacts once the server matches it; the fenced target stays for the tunnel.
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))).toBe(environment?.id)
    await expect(convert()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_migration_already_managed'
    })
  })

  it('keeps the source rows when retirement is off, marking the commit retained', async () => {
    retireSource = false
    try {
      await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
      expect(destination.commits).toBe(1)
      // An older build reads these rows and reaches the host over its relay.
      expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
      const [journal] = listOrcadMigrationSourceCutovers(userDataPath)
      expect(journal).toMatchObject({
        phase: 'destination-committed',
        sourceRetainedAt: '2026-10-02T00:00:00.000Z'
      })
      expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
      expect(getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))).toBe(
        journal?.destinationEnvironmentId
      )
    } finally {
      retireSource = true
    }
  })

  it('refuses before touching the host while terminals run or cannot be counted', async () => {
    store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'p', state: 'expired' })
    await expect(convert(null)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(releaseDirectSession).not.toHaveBeenCalled()
    expect(store.getSshTarget(TARGET.id)?.orcadFence).toBeUndefined()
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })

  it('keeps the fence across a deferred deploy and resumes the same migration', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'deferred',
      candidateVersion: '1.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'busy'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'deferred' })
    const [fenced] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(fenced?.phase).toBe('source-fenced')
    await expect(convert(null)).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: fenced?.migrationId
    })
    expect(destination.commits).toBe(1)
  })

  it('resumes after a lost commit reply without committing twice', async () => {
    const read = destination.readState.getMockImplementation()
    const commit = destination.commit.getMockImplementation()
    let reachable = true
    destination.readState.mockImplementation(async (manifest) => {
      if (!reachable) {
        throw new Error('socket closed')
      }
      return read!(manifest)
    })
    // The commit lands, then contact is lost before either the reply or a re-read arrives.
    destination.commit.mockImplementationOnce(async (manifest) => {
      await commit!(manifest)
      reachable = false
      throw new Error('socket closed')
    })
    await expect(convert()).rejects.toThrow('socket closed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')
    reachable = true
    await expect(convert(null)).resolves.toMatchObject({ outcome: 'converted' })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(store.getRepos()).toEqual([])
  })
})

/** What v1.4.218 and current main do with a stored target: keep every field, hide only `owner`. */
function shippedBuildView(targets: SshTarget[]): SshTarget[] {
  return JSON.parse(JSON.stringify(targets)).filter(
    (target: SshTarget) => target.owner?.type !== 'on-demand-runtime'
  )
}

describe('a converted host across a downgrade and back', () => {
  async function convertRetained(): Promise<void> {
    retireSource = false
    try {
      await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    } finally {
      retireSource = true
    }
  }

  it('stays visible, with its projects, to an older build', async () => {
    await convertRetained()
    const visible = shippedBuildView(store.getSshTargets())
    expect(visible.map((target) => target.id)).toEqual([TARGET.id])
    expect(store.getRepos().filter((repo) => repo.connectionId === TARGET.id)).toHaveLength(1)
    // This build hides the retained rows and serves the host from its managed server instead.
    expect(visibleRepos(store)).toEqual([])
  })

  it('goes back to managed after a downgrade that changed nothing', async () => {
    await convertRetained()
    reconcileManagedOrcadSshTargets(userDataPath, store)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store)).toEqual([])
  })

  it('keeps a host an older build changed on the relay, never merging a second manifest', async () => {
    await convertRetained()
    store.addRepo({
      id: 'repo-2',
      path: '/srv/tool',
      displayName: 'Tool',
      badgeColor: '#737373',
      addedAt: 2,
      kind: 'git',
      connectionId: TARGET.id
    })
    reconcileManagedOrcadSshTargets(userDataPath, store, () => new Date('2026-10-05T00:00:00Z'))
    expect(store.getSshTarget(TARGET.id)?.orcadFence).toMatchObject({
      sourceChangedAt: '2026-10-05T00:00:00.000Z'
    })
    expect(
      visibleRepos(store)
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
    expect(destination.commits).toBe(1)
  })

  it('restores a fence the profile lost from the registered managed server', async () => {
    await convertRetained()
    store.updateSshTarget(TARGET.id, { orcadFence: undefined })
    reconcileManagedOrcadSshTargets(userDataPath, store)
    expect(getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))).toBe(
      listEnvironments(userDataPath)[0]?.id
    )
  })
})
