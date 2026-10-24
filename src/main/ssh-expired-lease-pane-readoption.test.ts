import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePaneKey } from '../shared/stable-pane-id'
import { resolvePersistedStablePaneOwner } from './ipc/pty/pane/stable-owner'
import { adoptStablePane } from './ipc/pty/pane/adopt-stable'
import { PtyHostNotDispatchableError } from './ipc/pty/provider/registry'
import {
  testState,
  createStoreWithSshRemotePtyLeases,
  makeTerminalTab
} from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'
import { PtyExitProof } from './pty-exit-proof'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

const TARGET = 'ssh-1'
const HOST_ID = 'ssh:ssh-1' as const
const WORKTREE = 'repo1::/worktree'
const TAB = 'tab-1'
const APP_PTY_ID = 'ssh:ssh-1@@remote-pty'

function storeWithBoundRemotePane(
  state: 'attached' | 'expired' = 'attached'
): ReturnType<typeof createStoreWithSshRemotePtyLeases> {
  const store = createStoreWithSshRemotePtyLeases([
    {
      targetId: TARGET,
      ptyId: 'remote-pty',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state
    }
  ])
  store.setWorkspaceSession(
    {
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE,
      activeTabId: TAB,
      tabsByWorktree: {
        [WORKTREE]: [makeTerminalTab({ id: TAB, ptyId: APP_PTY_ID, worktreeId: WORKTREE })]
      },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: APP_PTY_ID }
        }
      }
    },
    HOST_ID
  )
  return store
}

// An expired lease does not prove the remote shell died; retain its owner for re-adoption.
describe('a pane whose SSH lease expired can still be re-adopted', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the persisted owner of an expired lease, so adoption reattaches', () => {
    const store = storeWithBoundRemotePane('expired')

    expect(
      resolvePersistedStablePaneOwner(store, makePaneKey(TAB, TEST_LEAF_1), WORKTREE, TARGET)
    ).toMatchObject({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: APP_PTY_ID })
  })

  it('drops the persisted owner after the lease is terminated', () => {
    const store = storeWithBoundRemotePane()

    store.markSshRemotePtyLease(TARGET, APP_PTY_ID, PtyExitProof.from('exit-observed', undefined))

    expect(
      resolvePersistedStablePaneOwner(store, makePaneKey(TAB, TEST_LEAF_1), WORKTREE, TARGET)
    ).toBeNull()
  })
})

// An unserved SSH host makes the PTY unverifiable; preserve its binding.
describe('recovery through createTerminal on an SSH host this process cannot reach', () => {
  const PANE_KEY = makePaneKey(TAB, TEST_LEAF_1)
  const ADOPT_ARGS = {
    cols: 120,
    rows: 40,
    cwd: '/worktree',
    connectionId: TARGET,
    worktreeId: WORKTREE,
    preAllocatedHandle: 'term-recovery',
    tabId: TAB,
    leafId: TEST_LEAF_1
  }

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('fails the adoption with a typed error and keeps the binding', async () => {
    const store = storeWithBoundRemotePane('expired')

    await expect(adoptStablePane(undefined, store, ADOPT_ARGS)).rejects.toBeInstanceOf(
      PtyHostNotDispatchableError
    )
    expect(resolvePersistedStablePaneOwner(store, PANE_KEY, WORKTREE, TARGET)).toMatchObject({
      ptyId: APP_PTY_ID
    })
  })
})
