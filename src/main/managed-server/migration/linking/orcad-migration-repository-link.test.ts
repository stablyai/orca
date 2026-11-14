import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { OrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest'
import {
  addManagedOrcadEnvironment,
  removeManagedOrcadEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import * as environments from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { Repo } from '../../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { Store } from '../../../persistence/loading-store/store'
import type { OrcadMigrationDestinationCatalog } from '../cutover/orcad-migration-cutover-coordinator'
import { storeBackedOrcadMigrationDestination } from '../cutover/testing/orcad-migration-destination-fake'
import { removeOrcadMigrationJournalsForDestination } from '../../../persistence/migrating-orcad-catalog/cutover-journals/orcad-migration-cutover-journal'

import { SshConnectionStore } from '../../../ssh/targets/ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('../../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore
}))
vi.mock('../../lifecycle/orcad-runtime-deployment', () => ({
  createManagedOrcadEnvironment: mocks.deploy
}))
vi.mock('../../lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: async () => {}
}))

const { convertSshTargetToManagedOrcad } = await import('../../lifecycle/orcad-runtime-conversion')

const TARGET: SshTarget = {
  id: 'ssh-shared',
  label: 'Shared box',
  host: 'box.example.com',
  port: 22,
  username: 'root',
  generation: 2
}
const onSsh = (id: string, targetId = TARGET.id) =>
  hostWorktreeTarget({ id, hostId: toSshExecutionHostId(targetId) })
const onServer = (id: string) => hostWorktreeTarget({ id, hostId: LOCAL_EXECUTION_HOST_ID })

function repo(id: string, path: string, connectionId: string | null = TARGET.id): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...(connectionId ? { connectionId } : {})
  }
}

let userDataPath: string
let store: Store
let server: Store
let targetStore: SshConnectionStore
let destination: OrcadMigrationDestinationCatalog & { stage: ReturnType<typeof vi.fn> }

/** Use the real server import behind migration calls. */
function serverDestination(): typeof destination {
  return {
    ...storeBackedOrcadMigrationDestination(server),
    stage: vi.fn(async (manifest: OrcadMigrationManifest) =>
      server.stageOrcadMigrationCatalog(manifest)
    ),
    abortByReference: vi.fn()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-repository-link-'))
  store = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'desktop', 'orca-data.json')
  })
  server = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'server', 'orca-data.json')
  })
  store.addSshTarget(TARGET)
  store.addRepo(repo('desktop-repo', '/root/migrepo'))
  store.addRepo(repo('desktop-only', '/root/tool'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  targetStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = targetStore
  destination = serverDestination()
  mocks.ensureTunnel.mockImplementation(environments.resolveEnvironment)
  mocks.deploy.mockImplementation(
    async (path: string, args: { name: string; sshTargetId: string }) => {
      const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(args.sshTargetId))
      if (!owner) {
        throw new Error('deploy without a fence')
      }
      if (!(await environments.listEnvironments(path)).some((entry) => entry.id === owner)) {
        await addManagedOrcadEnvironment(path, {
          id: owner,
          name: args.name,
          pairingCode: encodePairingOffer({
            v: PAIRING_OFFER_VERSION,
            endpoint: 'ws://127.0.0.1:46768/',
            deviceToken: 'device-token',
            publicKeyB64: 'public-key'
          }),
          orcadDeployment: {
            sshTargetId: args.sshTargetId,
            sshTargetGeneration: store.getSshTarget(args.sshTargetId)?.generation ?? 2,
            localPort: 46_768,
            remotePort: 6_768
          }
        })
      }
      // The running server of another Orca version, adopted as it is.
      return { outcome: 'already-current', environment: {}, activeVersion: '1.0.0' }
    }
  )
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const convert = (
  link = true,
  census: 'exited' | 'unverifiable' = 'exited',
  sshTargetId = TARGET.id
) =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId,
    name: sshTargetId === TARGET.id ? 'Managed' : `Managed ${sshTargetId}`,
    censusHost: async () => ({ verdict: census, count: 0 }),
    destinationFor: () => destination,
    ...(link
      ? {
          serverRepositoriesFor: async () => server.getRepos(),
          serverFolderCatalogFor: async () => ({
            folderWorkspaces: server.getFolderWorkspaces(),
            projectGroups: server.getProjectGroups()
          })
        }
      : {}),
    now: () => new Date('2026-10-14T00:00:00.000Z')
  })

const serverRepoIds = () =>
  server
    .getRepos()
    .map((entry) => entry.id)
    .sort()

// #29560: `orca environment stop` unlinks the server but leaves its profile on the host.
describe('moving the host again after its server was stopped', () => {
  // The local half of stop (unlinkEnvironmentLocally); the server keeps its profile.
  async function stopServer(): Promise<void> {
    const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))
    if (!owner) {
      throw new Error('no managed server to stop')
    }
    await removeManagedOrcadEnvironment(userDataPath, owner)
    targetStore.getOrcadRuntimeClaims().release(TARGET.id, owner)
    removeOrcadMigrationJournalsForDestination(userDataPath, TARGET.id, owner)
  }

  it('links the projects the server kept from the first move instead of conflicting', async () => {
    store.setWorktreeMeta(onSsh('desktop-repo::/root/migrepo'), {
      comment: 'before the first move'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.setWorktreeMeta(onServer('desktop-repo::/root/migrepo'), {
      comment: 'edited on the server'
    })
    await stopServer()

    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      linkedProjects: [
        { path: '/root/migrepo', automations: 0 },
        { path: '/root/tool', automations: 0 }
      ]
    })
    expect(serverRepoIds()).toEqual(['desktop-only', 'desktop-repo'])
    expect(server.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe(
      'edited on the server'
    )
    expect(store.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe(
      'before the first move'
    )
  })
})
