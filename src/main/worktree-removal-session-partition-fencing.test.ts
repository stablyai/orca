// Why this file exists: worktree removal writes to host session partitions, and the two hazards below
// are only visible across a removal followed by a renderer session write — persistence.test.ts covers
// removal and partitioning separately, so neither suite catches the interaction.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalTab } from '../shared/types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { toRuntimeExecutionHostId } from '../shared/execution-host'

const testState = { dir: '' }

vi.mock('./ssh/ssh-config-parser', () => ({
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
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
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
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // Regression: removal fenced the never-written partition, so main's empty copy became authoritative
  // and rebased away every sibling worktree's tabs on the first renderer write for that host.
  it('keeps sibling tabs when a worktree is removed before its host partition was ever persisted', async () => {
    const store = await createStore()
    store.setWorktreeMeta(STALE, { hostId: ENV_A })

    store.removeWorktreeMeta(STALE)

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
    store.setWorktreeMeta(STALE, { hostId: ENV_A })

    store.removeWorktreeMeta(STALE)

    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  it('does not materialize an unwritten host partition when removing session state directly', async () => {
    const store = await createStore()

    store.removeWorkspaceSessionStateForWorktree(STALE, ENV_A)

    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  // A persisted partition must still be fenced so main's copy wins over the renderer's stale tabs.
  it('still fences a host partition that was persisted before the removal', async () => {
    const store = await createStore()
    store.setWorktreeMeta(STALE, { hostId: ENV_A })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'stale-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    store.removeWorktreeMeta(STALE)

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

  // Regression: runtime removal purged only the host partition, so tabs the renderer had parked in the
  // local blob (its fallback whenever worktree ownership is unresolved) leaked forever.
  it('purges a runtime-owned worktree from the local blob as well as its host partition', async () => {
    const store = await createStore()
    store.setWorktreeMeta(STALE, { hostId: ENV_A })
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

    store.removeWorktreeMeta(STALE)

    expect(store.getWorkspaceSession().tabsByWorktree[STALE]).toBeUndefined()
    expect(store.getWorkspaceSession(ENV_A).tabsByWorktree[STALE]).toBeUndefined()
  })

  // Regression: an empty local blob counted as "no sibling to rebase", so a runtime removal claimed
  // repo-wide authority there and the renderer's next ownership-unresolved write lost its tabs.
  it('does not fence the local blob for a runtime removal it never held tabs for', async () => {
    const store = await createStore()
    store.setWorktreeMeta(STALE, { hostId: ENV_A })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [STALE]: [makeTerminalTab({ id: 'host-tab', worktreeId: STALE })] }
      },
      ENV_A
    )

    store.removeWorktreeMeta(STALE)

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

  // The owner's own partition still fences on emptiness: nothing of the repo lives there to rebase.
  it('fences the owning partition that holds no tabs for the removed worktree', async () => {
    const store = await createStore()
    const otherRepoWorktree = 'repo-other::/workspace/live'
    store.setWorktreeMeta(STALE, { hostId: ENV_A })
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

    store.removeWorktreeMeta(STALE)

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

  // The widened local purge must not fence the local blob when only siblings live there.
  it('does not fence the local blob that holds only sibling worktrees of the removed runtime worktree', async () => {
    const store = await createStore()
    store.setWorktreeMeta(STALE, { hostId: ENV_A })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [LIVE]: [makeTerminalTab({ id: 'live-tab', worktreeId: LIVE })] }
    })

    store.removeWorktreeMeta(STALE)

    expect(
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.['repo-gone']
    ).toBeUndefined()
    expect(store.getWorkspaceSession().tabsByWorktree[LIVE]?.map((tab) => tab.id)).toEqual([
      'live-tab'
    ])
  })
})
