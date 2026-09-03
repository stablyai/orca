import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePaneKey } from '../shared/stable-pane-id'
import { resolvePersistedStablePaneOwner } from './ipc/pty/pane/stable-owner'
import { adoptStablePane } from './ipc/pty/pane/adopt-stable'
import { sshProviders } from './ipc/pty/provider/registry'
import type { IPtyProvider } from './providers/types'
import { testState, createStore, makeTerminalTab } from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

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

function storeWithBoundRemotePane(): ReturnType<typeof createStore> {
  const store = createStore()
  store.upsertSshRemotePtyLease({
    targetId: TARGET,
    ptyId: 'remote-pty',
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: TEST_LEAF_1,
    state: 'attached'
  })
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

/**
 * `adoptStablePane` re-adopts a pane only while `resolvePersistedStablePaneOwner` can still name
 * its PTY. A null owner is what routes `createTerminal` to a fresh spawn — over a remote shell that
 * `expired` never claimed had died.
 */
describe('a pane whose SSH lease expired can still be re-adopted', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the persisted owner after the lease expires, so adoption reattaches', () => {
    const store = storeWithBoundRemotePane()

    store.markSshRemotePtyLease(TARGET, APP_PTY_ID, 'expired')

    expect(
      resolvePersistedStablePaneOwner(store, makePaneKey(TAB, TEST_LEAF_1), WORKTREE, TARGET)
    ).toMatchObject({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: APP_PTY_ID })
  })

  // Negative control for #17957: an operator close leaves `terminated`, and that must still unbind
  // the pane rather than re-adopting a shell the user deliberately stopped.
  it('drops the persisted owner after the lease is terminated', () => {
    const store = storeWithBoundRemotePane()

    store.markSshRemotePtyLease(TARGET, APP_PTY_ID, 'terminated')

    expect(
      resolvePersistedStablePaneOwner(store, makePaneKey(TAB, TEST_LEAF_1), WORKTREE, TARGET)
    ).toBeNull()
  })
})

/**
 * The other half of #17958: once `recoverTerminalPane` can find its lease it calls `createTerminal`,
 * whose FIRST act is `adoptStablePane`. These pin that this is a re-adopt entry point — an
 * attach-only reattach for a surviving orphan, and a fresh spawn only once the host itself answers
 * that the PTY is absent.
 */
describe('recovery through createTerminal reattaches before it respawns', () => {
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
    sshProviders.delete(TARGET)
  })

  it('reattaches the surviving orphan instead of spawning a second shell', async () => {
    const store = storeWithBoundRemotePane()
    store.markSshRemotePtyLease(TARGET, APP_PTY_ID, 'expired')
    const spawn = vi.fn(async (options: { sessionId?: string; attachOnly?: boolean }) => {
      void options
      return { id: APP_PTY_ID, isReattach: true as const, pid: 4242 }
    })
    sshProviders.set(TARGET, { spawn } as unknown as IPtyProvider)

    const adopted = await adoptStablePane(undefined, store, ADOPT_ARGS)

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      sessionId: APP_PTY_ID,
      attachOnly: true,
      command: undefined,
      launchAgent: undefined
    })
    expect(adopted?.result).toMatchObject({ id: APP_PTY_ID, isReattach: true })
    expect(adopted?.owner).toMatchObject({ ptyId: APP_PTY_ID, hasPersistedBinding: true })
  })

  it('falls through to a fresh spawn once the host answers that the PTY is absent', async () => {
    const store = storeWithBoundRemotePane()
    store.markSshRemotePtyLease(TARGET, APP_PTY_ID, 'expired')
    const spawn = vi.fn(async () => {
      throw new Error('PTY "remote-pty" not found')
    })
    sshProviders.set(TARGET, { spawn } as unknown as IPtyProvider)

    // A null adoption is exactly what routes createTerminal to a fresh shell, so a pane whose
    // shell genuinely died still gets a working terminal.
    await expect(adoptStablePane(undefined, store, ADOPT_ARGS)).resolves.toBeNull()
    expect(resolvePersistedStablePaneOwner(store, PANE_KEY, WORKTREE, TARGET)).toBeNull()
  })
})
