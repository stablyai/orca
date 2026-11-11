import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { Store } from '../../loading-store/store'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import { makeTerminalTab } from '../../persistence-session-fixtures'
import { wslMoveCutoverFixture as cutover } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { ProfileStateSqliteAuthority } from '../../profile-state/profile-state-sqlite-authority'
import { loadWslMoveFence, resetWslMoveFenceForTests } from '../quiescence/wsl-move-scope-guard'

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

  describe('once the host owns the project', () => {
    const tab = (id: string, contentType: Tab['contentType']): Tab => ({
      id,
      entityId: id,
      groupId: 'group-1',
      worktreeId: MOVING,
      contentType,
      label: id,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    })
    const group = (tabOrder: string[], activeTabId: string | null): TabGroup => ({
      id: 'group-1',
      worktreeId: MOVING,
      activeTabId,
      tabOrder
    })
    const withTabs = (base: WorkspaceSessionState, tabs: Tab[], active: string | null) => ({
      ...base,
      unifiedTabs: { [MOVING]: tabs },
      tabGroups: {
        [MOVING]: [
          group(
            tabs.map((entry) => entry.id),
            active
          )
        ]
      }
    })
    const movingTabs = (store: Store) => ({
      tabs: store.getWorkspaceSession().unifiedTabs?.[MOVING]?.map((entry) => entry.id),
      order: store.getWorkspaceSession().tabGroups?.[MOVING]?.[0]?.tabOrder,
      active: store.getWorkspaceSession().tabGroups?.[MOVING]?.[0]?.activeTabId
    })

    it("takes the project's chat tabs as written and keeps its terminals as the quiesce left them", () => {
      store.setWorkspaceSession(
        withTabs(
          session('slept', 'terminal'),
          [tab('moving-tab', 'terminal'), tab('agent-session:old', 'agent-session')],
          'moving-tab'
        )
      )
      seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
      // The renderer holds only the chats of a moved project: it dropped the terminal tab.
      store.setWorkspaceSession(
        withTabs(
          session('edited', 'editor'),
          [tab('agent-session:old', 'agent-session'), tab('agent-session:new', 'agent-session')],
          'agent-session:new'
        )
      )
      expect(titles(store)).toEqual({ moving: ['slept'], staying: ['edited'] })
      expect(movingTabs(store)).toEqual({
        tabs: ['moving-tab', 'agent-session:old', 'agent-session:new'],
        order: ['moving-tab', 'agent-session:old', 'agent-session:new'],
        active: 'agent-session:new'
      })

      // A closed chat goes; the slept terminal stays.
      store.setWorkspaceSession(
        withTabs(session('edited', 'editor'), [tab('agent-session:new', 'agent-session')], null)
      )
      expect(movingTabs(store)).toEqual({
        tabs: ['moving-tab', 'agent-session:new'],
        order: ['moving-tab', 'agent-session:new'],
        active: 'agent-session:new'
      })
    })
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
