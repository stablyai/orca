import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration-manifest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshManagedServerStatus, SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { fakeOrcadMigrationDestination } from '../ssh/orcad-migration-destination-fake'
import { assessOrcadMigrationTerminals } from '../ssh/orcad-migration-terminal-gate'
import { SshConnectionStore } from '../ssh/ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn() }
})
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: () => false
}))
vi.mock('../ssh/orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: vi.fn() }))
vi.mock('./ssh-connect-flow', () => ({ connectTarget: vi.fn() }))
vi.mock('./ssh-terminate-sessions', () => ({ terminateSshTargetSessions: vi.fn() }))
vi.mock('./ssh-session-teardown', () => ({ teardownSshTargetTransport: vi.fn() }))
vi.mock('./ssh-host-server-connect', () => ({ publishRelayTerminalsStatus: vi.fn() }))

const { convertSshTargetToManagedOrcad } = await import('../ssh/orcad-runtime-conversion')
const { moveSshHostToManagedServer } = await import('./ssh-managed-server-move')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
const HOST_ID = `ssh:${TARGET.id}` as const
const WORKTREE = 'repo-1::/srv/app'

let userDataPath: string
let store: Store
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-move-'))
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

/** Open relay terminal tabs: each tab, layout leaf and pane incarnation names its relay PTY. */
function openRelayTerminals(count: number): void {
  const terminals = Array.from({ length: count }, (_, index) => ({
    tabId: `tab-term-${index + 1}`,
    leafId: `11111111-1111-4111-8111-11111111111${index + 1}`,
    relayPtyId: `pty2:relay:${index + 1}`
  }))
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(HOST_ID),
      activeRepoId: 'repo-1',
      activeWorktreeId: WORKTREE,
      activeTabId: terminals[0].tabId,
      tabsByWorktree: {
        [WORKTREE]: terminals.map(({ tabId, relayPtyId }, index) => ({
          id: tabId,
          ptyId: `${HOST_ID}@@${relayPtyId}`,
          worktreeId: WORKTREE,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: 1
        }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        terminals.map(({ tabId, leafId, relayPtyId }) => [
          tabId,
          {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: `${HOST_ID}@@${relayPtyId}` }
          }
        ])
      ),
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        terminals.map(({ tabId, leafId }) => [`${tabId}:${leafId}`, `incarnation-${tabId}`])
      ),
      activeWorktreeIdsOnShutdown: [WORKTREE]
    },
    HOST_ID
  )
  for (const { tabId, leafId, relayPtyId } of terminals) {
    store.upsertSshRemotePtyLease({
      targetId: TARGET.id,
      ptyId: relayPtyId,
      worktreeId: WORKTREE,
      tabId,
      leafId,
      state: 'detached'
    })
  }
}

function moveDeps() {
  let status: SshManagedServerStatus | undefined
  return {
    getTarget: (targetId: string) => store.getSshTarget(targetId),
    // The relay acknowledged stopping every terminal.
    terminate: vi.fn(async (targetId: string) => {
      const leases = store.getSshRemotePtyLeases(targetId)
      for (const lease of leases) {
        store.markSshRemotePtyLease(targetId, lease.ptyId, 'terminated')
      }
      return { terminated: leases.length, unverifiable: 0 }
    }),
    // The reconnect's server decision: its census (no relay session, so the host's census, which
    // found no relay endpoint, decides with the leases) keeps the relay or lets it convert.
    connect: vi.fn(async (targetId: string) => {
      const proof = await assessOrcadMigrationTerminals(store, targetId, null, hostIdle)
      if (proof.verdict !== 'exited') {
        status = {
          kind: 'relay',
          reason:
            proof.verdict === 'live' ? 'relay_terminals_live' : 'relay_terminals_unverifiable',
          terminals: proof.ptyIds.length
        }
        return
      }
      const result = await convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: targetId,
        name: TARGET.label,
        listRelayPtyIds: null,
        censusHost: hostIdle,
        destinationFor: () => destination,
        releaseDirectSession: async () => {}
      })
      status =
        result.outcome === 'converted'
          ? { kind: 'managed', environmentId: result.environment.id }
          : { kind: 'relay', reason: 'refused', detail: 'reason' in result ? result.reason : '' }
    }),
    serverStatus: () => status,
    report: vi.fn(),
    releaseRelay: vi.fn(async () => {})
  }
}

async function hostIdle() {
  return { verdict: 'exited' as const, count: 0 }
}

function stagedSession() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stage receives the migration manifest as its first argument.
  const manifest = destination.stage.mock.calls[0]?.[0] as OrcadMigrationManifest
  return manifest.payload.dormantState?.workspaceSession
}

describe('moving a host whose live relay terminals kept it on the relay', () => {
  it('stops the terminal, converts, and carries its tab to orcad without the relay PTY', async () => {
    openRelayTerminals(1)
    const deps = moveDeps()

    await expect(moveSshHostToManagedServer(TARGET.id, deps)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(deps.terminate).toHaveBeenCalledWith(TARGET.id, expect.any(Function))
    const session = stagedSession()
    // No relay PTY id survives, so the tab spawns a fresh shell on the managed server.
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()).toMatchObject([
      { id: 'tab-term-1', ptyId: null }
    ])
    expect(session?.terminalLayoutsByTabId?.['tab-term-1']?.ptyIdsByLeafId).toBeUndefined()
    expect(session?.terminalPtyIncarnationsByPaneKey ?? {}).toEqual({})
  })

  it('moves two terminals whose stop lost its last reply to a relay that hung up (BUG-15)', async () => {
    openRelayTerminals(2)
    const deps = moveDeps()
    // Both shells died and their leases recorded it, but the second reply was lost.
    deps.terminate.mockImplementationOnce(async (targetId: string) => {
      store.markSshRemotePtyLease(targetId, 'pty2:relay:1', 'terminated')
      store.markSshRemotePtyLease(targetId, 'pty2:relay:2', 'terminated')
      throw new Error('Failed to terminate SSH host sessions: pty2:relay:2: Multiplexer disposed')
    })

    await expect(moveSshHostToManagedServer(TARGET.id, deps)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(deps.releaseRelay).toHaveBeenCalledWith(TARGET.id)
    expect(Object.values(stagedSession()?.tabsByWorktree ?? {}).flat()).toMatchObject([
      { id: 'tab-term-1', ptyId: null },
      { id: 'tab-term-2', ptyId: null }
    ])
  })

  it('refuses and refreshes the status when a failed stop left a terminal unproven', async () => {
    openRelayTerminals(2)
    const deps = moveDeps()
    deps.terminate.mockImplementationOnce(async (targetId: string) => {
      store.markSshRemotePtyLease(targetId, 'pty2:relay:1', 'terminated')
      throw new Error('Failed to terminate SSH host sessions: pty2:relay:2: Multiplexer disposed')
    })

    await expect(moveSshHostToManagedServer(TARGET.id, deps)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 1
    })
    // Reconnected on the relay, whose own gate refuses the conversion the same way.
    expect(deps.connect).toHaveBeenCalledWith(TARGET.id)
    expect(destination.stage).not.toHaveBeenCalled()
  })
})
