import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { buildHeadlessMobileSessionTerminalTabs } from '../runtime/mobile-session-terminal-projection'
import { advanceTerminalTopologyRevision } from '../runtime/workspace-session-terminal-membership-authority'
import {
  clearPaneSpawnReservation,
  makePaneSpawnReservationKey,
  reservePaneSpawn
} from './pty/pane/spawn-reservation'
import {
  createEmptyTabRetirementFixture,
  EMPTY_TAB,
  EMPTY_LEAF,
  EMPTY_INCARNATION
} from './session-empty-terminal-tab-retirement-fixture'

const fixtures: ReturnType<typeof createEmptyTabRetirementFixture>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  setRuntimeDesktopSurface(null)
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})
function fixture(armed = true) {
  const f = createEmptyTabRetirementFixture({ armed })
  fixtures.push(f)
  return f
}

it.each([false, true])('checks mounted=%s graph admitted before topology revision', (mounted) => {
  const f = fixture(false)
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph admission only checks window and WebContents destruction.
      return { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as never
    },
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  f.runtime.attachWindow(1)
  const session = f.store.getWorkspaceSession()
  const tabs = buildHeadlessMobileSessionTerminalTabs(
    f.worktreeId,
    session.tabsByWorktree[f.worktreeId],
    session
  )
  f.runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: EMPTY_TAB,
        worktreeId: f.worktreeId,
        title: null,
        activeLeafId: mounted ? EMPTY_LEAF : null,
        layout: mounted ? { type: 'leaf', leafId: EMPTY_LEAF } : null
      }
    ],
    leaves: mounted
      ? [
          {
            tabId: EMPTY_TAB,
            worktreeId: f.worktreeId,
            leafId: EMPTY_LEAF,
            paneRuntimeId: 1,
            ptyId: null
          }
        ]
      : [],
    mobileSessionTabs: [
      {
        worktree: f.worktreeId,
        publicationEpoch: 'empty-tab-owner',
        snapshotVersion: 1,
        activeTabId: tabs[0].id,
        activeTabType: 'terminal',
        activeGroupId: null,
        tabs
      }
    ]
  })
  f.store.setWorkspaceSession(
    advanceTerminalTopologyRevision(f.store.getWorkspaceSession(), f.worktreeId)
  )
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[EMPTY_TAB].root).toBeNull()
  expect(f.close()).toEqual(mounted ? { closed: false, reason: 'runtime-owner' } : { closed: true })
})

it('permits a fresh close after pending spawn fails and releases ownership', () => {
  const f = fixture()
  const key = makePaneSpawnReservationKey(f.worktreeId, null, `${EMPTY_TAB}:${EMPTY_LEAF}`)
  if (!key) {
    throw new Error('Missing reservation key')
  }
  const reservation = reservePaneSpawn(key)
  try {
    expect(f.close()).toEqual({ closed: false, reason: 'runtime-owner' })
    reservation.reject(new Error('spawn rejected'))
    clearPaneSpawnReservation(key, reservation)
    expect(f.close()).toEqual({ closed: true })
  } finally {
    clearPaneSpawnReservation(key, reservation)
  }
})

it.each(['query', 'flush'] as const)(
  'provider completion queued during %s runs after synchronous close',
  async (boundary) => {
    const f = fixture()
    const stale = structuredClone(f.store.getWorkspaceSession())
    let completion: Promise<void> | undefined
    const queueSuccessor = () => {
      completion ??= Promise.resolve().then(() => {
        expect(
          f.store.persistPtyBinding({
            worktreeId: f.worktreeId,
            tabId: EMPTY_TAB,
            leafId: EMPTY_LEAF,
            ptyId: 'successor',
            incarnationId: EMPTY_INCARNATION,
            hostAdmittedMembership: true
          })
        ).toBe(true)
        f.runtime.registerPty('successor', f.worktreeId, null, {
          tabId: EMPTY_TAB,
          leafId: EMPTY_LEAF
        })
      })
    }
    if (boundary === 'query') {
      const read = f.runtime.hasEmptyTerminalTabRetirementOwner.bind(f.runtime)
      vi.spyOn(f.runtime, 'hasEmptyTerminalTabRetirementOwner').mockImplementation(
        (worktree, tab) => {
          const owned = read(worktree, tab)
          queueSuccessor()
          return owned
        }
      )
    } else {
      const flush = f.store.flushOrThrow.bind(f.store)
      vi.spyOn(f.store, 'flushOrThrow').mockImplementation(() => {
        queueSuccessor()
        flush()
      })
    }
    expect(f.close()).toEqual({ closed: true })
    expect(completion).toBeDefined()
    expect(f.hasTab()).toBe(false)
    await completion
    const successor = structuredClone(f.store.getWorkspaceSession().tabsByWorktree[f.worktreeId][0])
    stale.tabsByWorktree[f.worktreeId] = []
    f.store.setWorkspaceSession(stale)
    expect(f.store.getWorkspaceSession().tabsByWorktree[f.worktreeId][0]).toEqual(successor)
    expect(f.runtime.resolveTerminalPane(`${EMPTY_TAB}:${EMPTY_LEAF}`, f.worktreeId).ptyId).toBe(
      'successor'
    )
    expect(f.close()).toMatchObject({ closed: false })
  }
)
