import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../persistence/loading-store/store'
import { advanceTerminalTopologyRevision } from '../runtime/workspace-session-terminal-membership-authority'
import {
  claimRuntimePaneCreate,
  clearPaneSpawnReservation,
  makePaneSpawnReservationKey,
  reservePaneSpawn
} from './pty/pane/spawn-reservation'
import { stablePaneAdoptionsByOwnerKey } from './pty/pane/stable-owner'
import { retireEmptyTerminalTab } from './session-empty-terminal-tab-retirement'
import {
  createEmptyTabRetirementFixture,
  EMPTY_TAB,
  EMPTY_LEAF,
  EMPTY_INCARNATION
} from './session-empty-terminal-tab-retirement-fixture'

const fixtures: ReturnType<typeof createEmptyTabRetirementFixture>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})
function fixture(options?: Parameters<typeof createEmptyTabRetirementFixture>[0]) {
  const f = createEmptyTabRetirementFixture(options)
  fixtures.push(f)
  return f
}

it.each([false, true])('persists empty retirement through stale saves for folder=%s', (folder) => {
  const f = fixture({ folder })
  const stale = structuredClone(f.store.getWorkspaceSession())
  expect(f.close()).toEqual({ closed: true })
  f.store.setWorkspaceSession(stale)
  f.store.flushOrThrow()
  const restored = new Store({ dataFile: f.dataFile })
  expect(restored.getWorkspaceSession().tabsByWorktree[f.worktreeId]).toHaveLength(0)
  restored.flush()
  expect(f.close()).toEqual({ closed: true })
})

it.each(['ssh:remote', 'runtime:foreign'] as const)('refuses execution host %s', (host) => {
  const f = fixture({ host })
  expect(f.close()).toEqual({ closed: false, reason: 'not-local' })
  expect(f.hasTab()).toBe(true)
})

it('preserves renderer membership when a scope has no host revision', () => {
  const f = fixture({ armed: false })
  expect(f.close()).toEqual({ closed: false, reason: 'renderer-owned-membership' })
  expect(f.hasTab()).toBe(true)
})

it.each(['isPinned', 'createdAt', 'generation'] as const)('rechecks current %s', (field) => {
  const f = fixture()
  const current = f.store.getWorkspaceSession()
  f.store.setWorkspaceSession(
    advanceTerminalTopologyRevision(
      {
        ...current,
        tabsByWorktree: {
          [f.worktreeId]: current.tabsByWorktree[f.worktreeId].map((tab) => ({
            ...tab,
            [field]: field === 'isPinned' ? true : 2
          }))
        }
      },
      f.worktreeId
    )
  )
  expect(f.close()).toEqual({ closed: false, reason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

const OTHER_TAB = '44444444-4444-4444-8444-444444444444'
for (const kind of ['spawn', 'runtime-create', 'adoption'] as const) {
  it.each([EMPTY_TAB, OTHER_TAB])(`checks %s ownership during ${kind}`, (ownerTab) => {
    const f = fixture()
    const key = makePaneSpawnReservationKey(f.worktreeId, null, `${ownerTab}:${EMPTY_LEAF}`)
    if (!key) {
      throw new Error('Missing reservation key')
    }
    const reservation = kind === 'spawn' ? reservePaneSpawn(key) : undefined
    const release = kind === 'runtime-create' ? claimRuntimePaneCreate(key) : undefined
    if (kind === 'adoption') {
      stablePaneAdoptionsByOwnerKey.set(key, new Promise(() => {}))
    }
    try {
      expect(f.close()).toEqual(
        ownerTab === EMPTY_TAB ? { closed: false, reason: 'runtime-owner' } : { closed: true }
      )
      expect(f.hasTab()).toBe(ownerTab === EMPTY_TAB)
      if (ownerTab === EMPTY_TAB) {
        expect(
          f.store.persistPtyBinding({
            worktreeId: f.worktreeId,
            tabId: EMPTY_TAB,
            leafId: EMPTY_LEAF,
            ptyId: 'pending-owner',
            incarnationId: EMPTY_INCARNATION
          })
        ).toBe(true)
      }
    } finally {
      if (reservation) {
        reservation.resolve({ id: 'pending-owner' })
        clearPaneSpawnReservation(key, reservation)
      }
      release?.()
      if (kind === 'adoption') {
        stablePaneAdoptionsByOwnerKey.delete(key)
      }
    }
  })
}

it.each([EMPTY_TAB, OTHER_TAB])('checks unpersisted runtime PTY for %s', (ownerTab) => {
  const f = fixture()
  f.runtime.registerPty('runtime-owner', f.worktreeId, null, {
    tabId: ownerTab,
    leafId: EMPTY_LEAF
  })
  const handle = f.runtime.getTerminalHandleForPaneKey(`${ownerTab}:${EMPTY_LEAF}`)
  expect(handle).not.toBeNull()
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[EMPTY_TAB].root).toBeNull()
  expect(f.close()).toEqual(
    ownerTab === EMPTY_TAB ? { closed: false, reason: 'runtime-owner' } : { closed: true }
  )
  expect(f.runtime.getTerminalHandleForPaneKey(`${ownerTab}:${EMPTY_LEAF}`)).toBe(handle)
})

it('does not acknowledge unavailable ownership or failed durable flush', () => {
  const f = fixture()
  expect(retireEmptyTerminalTab(f.store, undefined, f.request)).toEqual({
    closed: false,
    reason: 'runtime-unavailable'
  })
  vi.spyOn(f.store, 'flushOrThrow').mockImplementation(() => {
    throw new Error('disk-full')
  })
  expect(f.close).toThrow('disk-full')
  const restored = new Store({ dataFile: f.dataFile })
  expect(restored.getWorkspaceSession().tabsByWorktree[f.worktreeId]).toHaveLength(1)
  restored.flush()
})

it('allows a later admitted incarnation and protects it from the old request', () => {
  const f = fixture()
  expect(f.close()).toEqual({ closed: true })
  expect(
    f.store.persistPtyBinding({
      worktreeId: f.worktreeId,
      tabId: EMPTY_TAB,
      leafId: EMPTY_LEAF,
      ptyId: 'later-owner',
      incarnationId: EMPTY_INCARNATION,
      hostAdmittedMembership: true
    })
  ).toBe(true)
  f.runtime.registerPty('later-owner', f.worktreeId, null, { tabId: EMPTY_TAB, leafId: EMPTY_LEAF })
  expect(f.close()).toMatchObject({ closed: false })
  expect(f.runtime.resolveTerminalPane(`${EMPTY_TAB}:${EMPTY_LEAF}`, f.worktreeId).ptyId).toBe(
    'later-owner'
  )
  expect(f.hasTab()).toBe(true)
})
