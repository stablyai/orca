import { hostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  createSqliteTestStore,
  testState
} from './persistence/persistence-test-harness'
import { Store as CanonicalStore } from './persistence/loading-store/store'
import { initDataPath as initCanonicalDataPath } from './persistence/loading-store/user-data-path'
import { resetRetirementCollisionKeyCacheForTests } from './worktree-name-retirement'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalTab } from '../shared/terminal-tab-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { toRuntimeExecutionHostId } from '../shared/execution-host'
import { removeWorktreeMetaRow } from './persistence/host-qualified-worktree-meta'

let hasCreatedStoreInCase = false

vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

async function createStore() {
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    initCanonicalDataPath()
    return createSqliteTestStore(CanonicalStore, {
      dataFile: join(testState.dir, 'orca-data.json')
    })
  }
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

const makeTerminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab1',
  ptyId: 'pty1',
  worktreeId: 'repo::/worktree',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

const ENV_A = toRuntimeExecutionHostId('env-a')
const STALE = 'repo-gone::/workspace/stale'
const LIVE = 'repo-gone::/workspace/live'

describe('worktree removal across host session partitions', () => {
  beforeEach(() => {
    hasCreatedStoreInCase = false
    resetRetirementCollisionKeyCacheForTests()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps sibling tabs when a worktree is removed before its host partition was ever persisted', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })

    removeWorktreeMetaRow(store, STALE, undefined)

    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [LIVE]: [makeTerminalTab({ id: 'live-tab', worktreeId: LIVE })] }
      },
      ENV_A
    )

    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[LIVE]?.map((tab) => tab.id)).toEqual([
      'live-tab'
    ])
  })

  it('does not materialize an unwritten host partition when removing a worktree', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })

    removeWorktreeMetaRow(store, STALE, undefined)

    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  it('does not materialize an unwritten host partition when removing session state directly', async () => {
    const store = await createStore()

    store.removeWorkspaceSessionStateForWorktree(hostWorktreeTarget({ id: STALE, hostId: ENV_A }))

    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  it('still fences a host partition that was persisted before the removal', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'stale-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    removeWorktreeMetaRow(store, STALE, undefined)

    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[STALE]).toBeUndefined()
    expect(store.getWorkspaceSession(ENV_A).terminalTopologyRevisionByRepoId?.['repo-gone']).toBe(1)

    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'stale-tab', worktreeId: STALE })] }
      },
      ENV_A
    )
    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[STALE]).toEqual([])
  })

  it('purges a runtime-owned worktree from the local blob as well as its host partition', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [STALE]: [makeTerminalTab({ id: 'local-fallback-tab', worktreeId: STALE })]
      }
    })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'host-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    removeWorktreeMetaRow(store, STALE, undefined)

    expect(store.getWorkspaceSession().tabsByWorktree[STALE]).toBeUndefined()
    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[STALE]).toBeUndefined()
  })

  it('does not fence the local blob for a runtime removal it never held tabs for', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'host-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    removeWorktreeMetaRow(store, STALE, undefined)

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [LIVE]: [makeTerminalTab({ id: 'live-tab', worktreeId: LIVE })] }
    })

    expect(store.getWorkspaceSession().tabsByWorktree[LIVE]?.map((tab) => tab.id)).toEqual([
      'live-tab'
    ])
    expect(
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.['repo-gone']
    ).toBeUndefined()
  })

  it('fences the owning partition that holds no tabs for the removed worktree', async () => {
    const store = await createStore()
    const otherRepoWorktree = 'repo-other::/workspace/live'
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [otherRepoWorktree]: [
            makeTerminalTab({ id: 'other-repo-tab', worktreeId: otherRepoWorktree })
          ]
        }
      },
      ENV_A
    )

    removeWorktreeMetaRow(store, STALE, undefined)

    expect(store.getWorkspaceSession(ENV_A).terminalTopologyRevisionByRepoId?.['repo-gone']).toBe(1)

    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'delayed-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[STALE]).toEqual([])
  })

  it('does not fence the local blob that holds only sibling worktrees of the removed runtime worktree', async () => {
    const store = await createStore()
    store.setWorktreeMeta(hostWorktreeTarget({ id: STALE, hostId: ENV_A }), { hostId: ENV_A })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [LIVE]: [makeTerminalTab({ id: 'live-tab', worktreeId: LIVE })] }
    })

    removeWorktreeMetaRow(store, STALE, undefined)

    expect(
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.['repo-gone']
    ).toBeUndefined()
    expect(store.getWorkspaceSession().tabsByWorktree[LIVE]?.map((tab) => tab.id)).toEqual([
      'live-tab'
    ])
  })
})
