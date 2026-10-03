import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { keepOrcadServerVersion, runOrcadDeltaMove } from './orcad-migration-delta-move'
import { planOrcadDeltaMove } from './orcad-migration-delta-plan'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { retireRetainedOrcadSourceChain } from './orcad-retained-source-retirement'
import { SshConnectionStore } from './ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: () => false
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
let sshStore: SshConnectionStore
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-delta-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo(repo('repo-1', '/srv/app'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  sshStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = sshStore
  destination = fakeOrcadMigrationDestination()
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const id = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))!
    if (!listEnvironments(path).some((entry) => entry.id === id)) {
      addManagedOrcadEnvironment(path, {
        id,
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

const now = () => new Date('2026-10-03T00:00:00.000Z')

/** Converted with source retirement off, then an older build adds repo-2 and renames repo-1. */
async function convertedThenChangedOnOlderBuild(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: async () => [],
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now,
      retireSource: () => false
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
  store.addRepo(repo('repo-2', '/srv/tool'))
  store.updateRepo('repo-1', { displayName: 'app-renamed' })
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
  expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
}

function deltaMove() {
  const target = store.getSshTarget(TARGET.id)!
  return runOrcadDeltaMove({
    userDataPath,
    store,
    claims: sshStore.getOrcadRuntimeClaims(),
    target,
    environment: listEnvironments(userDataPath)[0]!,
    destination,
    listRelayPtyIds: async () => [],
    releaseDirectSession: async () => {},
    ensureTunnel: async () => {},
    now
  })
}

describe('moving what an older build added to a converted host', () => {
  it('previews additions and what the server keeps, then moves only the additions', async () => {
    await convertedThenChangedOnOlderBuild()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-2'])
    expect(plan.notReflected.edited.map((row) => row.id)).toEqual(['repo-1'])
    expect(plan.notReflected.removed).toEqual([])

    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
    const journals = listOrcadMigrationSourceCutovers(userDataPath)
    const [first, delta] = [...journals].sort((a) => (a.supersedesMigrationId ? 1 : -1))
    expect(delta?.supersedesMigrationId).toBe(first?.migrationId)
    expect(delta?.manifest.payload.repositories.map((row) => row.id)).toEqual(['repo-2'])
    expect(journals.every((journal) => journal.sourceRetainedAt)).toBe(true)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store)).toEqual([])
    // Back to managed, and a start with nothing new keeps it there.
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('fails the whole delta when the server already holds a colliding row', async () => {
    await convertedThenChangedOnOlderBuild()
    destination.stage.mockRejectedValueOnce(
      new Error('orcad_migration_repository_id_conflict:repo-2')
    )
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_delta_refused_by_server',
      reason: 'orcad_migration_repository_id_conflict:repo-2'
    })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    expect(
      visibleRepos(store)
        .map((row) => row.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
  })

  it('keeps the server version: back to managed, the older build changes stay unshown', async () => {
    await convertedThenChangedOnOlderBuild()
    await keepOrcadServerVersion({
      userDataPath,
      store,
      claims: sshStore.getOrcadRuntimeClaims(),
      target: store.getSshTarget(TARGET.id)!
    })
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store)).toEqual([])
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(destination.commits).toBe(1)
  })

  it('retires both manifests once retirement is on, never before the delta commits', async () => {
    await convertedThenChangedOnOlderBuild()
    const target = () => store.getSshTarget(TARGET.id)!
    const lifecycle = <T>(_id: string, run: () => Promise<T>) => run()
    // Changed and not yet moved: nothing retires.
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).resolves.toBe('skipped')
    expect(store.getRepos()).toHaveLength(2)

    await deltaMove()
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).resolves.toBe('retired')
    expect(store.getRepos()).toEqual([])
    expect(getManagedOrcadFenceEnvironmentId(target())).toBe(listEnvironments(userDataPath)[0]?.id)
  })

  it('survives a second downgrade and re-upgrade after the delta move', async () => {
    await convertedThenChangedOnOlderBuild()
    await deltaMove()
    // A second trip to an older build adds another project.
    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-3'])
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(3)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(3)
    expect(visibleRepos(store)).toEqual([])
  })
})
