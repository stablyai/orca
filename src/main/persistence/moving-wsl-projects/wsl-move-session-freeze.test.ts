import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../../persistence'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { pruneWorktreeStateForRepo } from '../tracking-repos/repo-worktree-pruning'
import { wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MOVING = 'repo-1::/home/dev/repo-1'
const STAYING = 'repo-2::/home/dev/repo-2'

function session(title: string, tabType: 'terminal' | 'editor'): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [MOVING]: [makeTerminalTab({ id: 'moving-tab', ptyId: null, worktreeId: MOVING, title })],
      [STAYING]: [makeTerminalTab({ id: 'staying-tab', ptyId: null, worktreeId: STAYING, title })]
    },
    terminalLayoutsByTabId: {
      'moving-tab': { root: null, activeLeafId: null, expandedLeafId: null },
      'staying-tab': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabTypeByWorktree: { [MOVING]: tabType, [STAYING]: tabType }
  }
}

const titles = (store: Store) => {
  const { tabsByWorktree } = store.getWorkspaceSession()
  return {
    moving: tabsByWorktree[MOVING]?.map((tab) => tab.title),
    staying: tabsByWorktree[STAYING]?.map((tab) => tab.title)
  }
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-freeze-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
  store.setWorkspaceSession(session('slept', 'terminal'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('WSL move session freeze', () => {
  it("lets the quiesce's own Sleep write while the move is only fenced", () => {
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    store.setWorkspaceSession(session('after-sleep', 'terminal'))
    expect(titles(store)).toEqual({ moving: ['after-sleep'], staying: ['after-sleep'] })
  })

  describe('once quiesced', () => {
    beforeEach(() => {
      seedWslMoveCutover(testState.dir, cutover('move-1', 'quiesced'))
    })

    it('keeps the moving workspace as the quiesce left it and takes the rest', () => {
      store.setWorkspaceSession(session('edited', 'editor'))
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
      expect(store.getWorkspaceSession().activeTabTypeByWorktree).toEqual({
        [MOVING]: 'terminal',
        [STAYING]: 'editor'
      })
    })

    it('keeps it when a write omits the workspace entirely', () => {
      const without = session('edited', 'editor')
      delete without.tabsByWorktree[MOVING]
      store.setWorkspaceSession(without)
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
    })

    it('keeps it through a patch and the before-unload stage', () => {
      store.patchWorkspaceSession({
        activeTabTypeByWorktree: { [MOVING]: 'editor', [STAYING]: 'editor' }
      })
      expect(store.getWorkspaceSession().activeTabTypeByWorktree).toEqual({
        [MOVING]: 'terminal',
        [STAYING]: 'editor'
      })
      store.stageWorkspaceSessionBeforeUnload(session('quit', 'editor'))
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['quit'] })
    })
  })

  it('keeps freezing through commit, so the retained rows survive for a downgrade', () => {
    seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
    store.setWorkspaceSession(session('edited', 'editor'))
    expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
  })

  it('freezes nothing, with one warning, when the journal cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directory = wslMoveJournalDirectory(testState.dir)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'move-1.json'), '{not json')
    loadWslMoveFence(testState.dir)
    store.setWorkspaceSession(session('edited', 'editor'))
    expect(titles(store)).toEqual({ moving: ['edited'], staying: ['edited'] })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('WSL move session freeze: other session writers', () => {
  beforeEach(() => {
    seedWslMoveCutover(testState.dir, cutover('move-1', 'quiesced'))
  })

  it('keeps the frozen rows through a failed durable mutation that rolls the session back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refuse = () => {
      throw new Error('disk refused')
    }
    const authority = ProfileStateSqliteAuthority.prototype
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(refuse)
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(refuse)
    vi.spyOn(authority, 'writeSerializedState').mockImplementationOnce(refuse)
    await expect(
      store.runDurableMutation(() => {
        store.setWorkspaceSession(session('mutated', 'editor'))
        return {
          value: undefined,
          rollback: () => store.setWorkspaceSession(session('rolled-back', 'editor'))
        }
      })
    ).rejects.toThrow('disk refused')
    expect(titles(store)).toEqual({ moving: ['slept'], staying: ['rolled-back'] })
  })

  it('keeps the frozen rows when the repo is pruned', () => {
    const state = getDefaultPersistedState(testState.dir)
    state.workspaceSession = {
      ...store.getWorkspaceSession(),
      lastVisitedAtByWorktreeId: { [MOVING]: 1, [STAYING]: 1 }
    }
    pruneWorktreeStateForRepo(state, 'repo-1', null, () => undefined)
    pruneWorktreeStateForRepo(state, 'repo-2', null, () => undefined)
    expect(Object.keys(state.workspaceSession.tabsByWorktree)).toEqual([MOVING])
  })

  it('keeps the frozen rows when the workspace owner is removed', () => {
    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: MOVING, hostId: 'local' })
    )
    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: STAYING, hostId: 'local' })
    )
    expect(titles(store)).toEqual({ moving: ['slept'], staying: undefined })
  })
})
