import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import {
  makeTerminalTab,
  makeRepo,
  createStore,
  testState,
  readDataFile
} from './persistence-test-harness'
import type { PersistedState } from '../shared/persisted-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo-transfer::/worktree'
const OTHER_WORKTREE = 'repo-transfer::/other'
const TAB = 'transfer-tab'
const PTY = 'transfer-pty'
const INCARNATION = 'transfer-incarnation'

const binding = (
  overrides: Partial<Parameters<ReturnType<typeof createStore>['persistPtyBinding']>[0]> = {}
) => ({
  worktreeId: WORKTREE,
  tabId: TAB,
  leafId: TEST_LEAF_1,
  ptyId: PTY,
  incarnationId: INCARNATION,
  bindingMode: 'strict-transfer-publication' as const,
  ...overrides
})

function sessionWithSurface(
  args: {
    ownerWorktreeId?: string
    tabWorktreeId?: string
    tabId?: string
    leafId?: string
    ptyId?: string
    incarnationId?: string
  } = {}
): WorkspaceSessionState {
  const ownerWorktreeId = args.ownerWorktreeId ?? WORKTREE
  const tabWorktreeId = args.tabWorktreeId ?? ownerWorktreeId
  const tabId = args.tabId ?? TAB
  const leafId = args.leafId ?? TEST_LEAF_1
  const ptyId = args.ptyId ?? PTY
  const incarnationId = args.incarnationId ?? INCARNATION
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [ownerWorktreeId]: [makeTerminalTab({ id: tabId, worktreeId: tabWorktreeId, ptyId })]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [`${tabId}:${leafId}`]: incarnationId
    }
  }
}

describe('strict PTY ownership-transfer binding admission', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-binding-'))
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-transfer' }))
    store.flushOrThrow()
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('publishes a new exact surface and accepts only an exact durable retry', () => {
    const store = createStore()

    expect(store.persistPtyBinding(binding())).toBe(true)
    const published = structuredClone(store.getWorkspaceSession())
    expect(published.tabsByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ id: TAB, worktreeId: WORKTREE, ptyId: PTY })
    ])
    expect(published.terminalLayoutsByTabId[TAB]).toMatchObject({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      ptyIdsByLeafId: { [TEST_LEAF_1]: PTY }
    })
    expect(published.terminalPtyIncarnationsByPaneKey?.[`${TAB}:${TEST_LEAF_1}`]).toBe(INCARNATION)
    expect(published.terminalTopologyRevisionByRepoId?.['repo-transfer']).toBe(1)

    expect(store.persistPtyBinding(binding())).toBe(true)
    expect(store.getWorkspaceSession()).toEqual(published)
    expect((readDataFile() as PersistedState).workspaceSession.tabsByWorktree[WORKTREE]).toEqual(
      published.tabsByWorktree[WORKTREE]
    )
    const reloaded = createStore().getWorkspaceSession()
    expect(reloaded.tabsByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ id: TAB, worktreeId: WORKTREE, ptyId: PTY })
    ])
    expect(reloaded.terminalLayoutsByTabId[TAB]).toEqual(published.terminalLayoutsByTabId[TAB])
    expect(reloaded.terminalPtyIncarnationsByPaneKey).toEqual(
      published.terminalPtyIncarnationsByPaneKey
    )
  })

  it.each([
    [
      'tab',
      sessionWithSurface({
        ownerWorktreeId: OTHER_WORKTREE,
        tabWorktreeId: OTHER_WORKTREE,
        leafId: TEST_LEAF_2,
        ptyId: 'other-pty',
        incarnationId: 'other-incarnation'
      })
    ],
    [
      'leaf',
      sessionWithSurface({
        leafId: TEST_LEAF_2,
        ptyId: 'other-pty',
        incarnationId: 'other-incarnation'
      })
    ],
    ['PTY', sessionWithSurface({ ptyId: 'other-pty' })],
    [
      'legacy PTY',
      {
        ...sessionWithSurface(),
        tabsByWorktree: {
          [WORKTREE]: [
            makeTerminalTab({ id: TAB, worktreeId: WORKTREE, ptyId: 'other-legacy-pty' })
          ]
        }
      }
    ],
    ['incarnation', sessionWithSurface({ incarnationId: 'other-incarnation' })],
    [
      'partial incarnation',
      {
        ...getDefaultWorkspaceSession(),
        terminalPtyIncarnationsByPaneKey: {
          [`${TAB}:${TEST_LEAF_1}`]: 'other-incarnation'
        }
      }
    ],
    [
      'extra leaf or PTY',
      {
        ...sessionWithSurface(),
        terminalLayoutsByTabId: {
          [TAB]: {
            root: {
              type: 'split' as const,
              direction: 'vertical' as const,
              first: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
              second: { type: 'leaf' as const, leafId: TEST_LEAF_2 }
            },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [TEST_LEAF_1]: PTY,
              [TEST_LEAF_2]: 'extra-pty'
            }
          }
        }
      }
    ]
  ])('rejects a differing %s without mutation', (_conflict, session) => {
    const store = createStore()
    store.setWorkspaceSession(session)
    const before = structuredClone(store.getWorkspaceSession())
    const flush = vi.spyOn(store, 'flushOrThrow')

    expect(store.persistPtyBinding(binding())).toBe(false)

    expect(flush).not.toHaveBeenCalled()
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('rejects a tombstone without mutation', () => {
    const store = createStore()
    store.setWorkspaceSession(sessionWithSurface())
    store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey = {
      [`${TAB}:${TEST_LEAF_1}`]: {
        worktreeId: WORKTREE,
        parentTabId: TAB,
        leafId: TEST_LEAF_1,
        ptyId: PTY,
        incarnationId: INCARNATION,
        retiredAt: 1
      }
    }
    const before = structuredClone(store.getWorkspaceSession())
    const flush = vi.spyOn(store, 'flushOrThrow')

    expect(store.persistPtyBinding(binding())).toBe(false)

    expect(flush).not.toHaveBeenCalled()
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it.each([
    ['ssh:ssh-1', 'ssh:ssh-1@@remote-pty'],
    ['runtime:env-a', 'remote:env-a@@remote-pty']
  ])('publishes only in the owning %s partition', (hostId, ptyId) => {
    const store = createStore()
    const local = sessionWithSurface({
      leafId: TEST_LEAF_2,
      ptyId: 'local-conflict-pty',
      incarnationId: 'local-conflict-incarnation'
    })
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(getDefaultWorkspaceSession(), hostId)

    expect(
      store.persistPtyBinding(binding({ ptyId, incarnationId: `${INCARNATION}-${hostId}` }), hostId)
    ).toBe(true)

    expect(store.getWorkspaceSession()).toEqual(local)
    const owner = store.getWorkspaceSession(hostId)
    expect(owner.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]).toBe(ptyId)
    expect(owner.terminalPtyIncarnationsByPaneKey?.[`${TAB}:${TEST_LEAF_1}`]).toBe(
      `${INCARNATION}-${hostId}`
    )
  })

  it('rolls back only the owning partition when the publication flush fails', () => {
    const store = createStore()
    const local = sessionWithSurface({
      tabId: 'local-tab',
      ptyId: 'local-pty',
      incarnationId: 'local-incarnation'
    })
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:ssh-1')
    const ownerBefore = structuredClone(store.getWorkspaceSession('ssh:ssh-1'))
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })

    expect(() =>
      store.persistPtyBinding(binding({ ptyId: 'ssh:ssh-1@@remote-pty' }), 'ssh:ssh-1')
    ).toThrow('disk unavailable')

    expect(store.getWorkspaceSession('ssh:ssh-1')).toEqual(ownerBefore)
    expect(store.getWorkspaceSession()).toEqual(local)
  })
})
