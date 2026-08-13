import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree-id'
import { OrcaRuntimeService } from './orca-runtime'

/**
 * Journey: git-worktree, folder-workspace and floating namespaces must all resolve
 * terminal identity from one stable host-local workspace id. Neither the filesystem
 * path, the client's repository id, nor the caller's target id may stand in for it.
 * Drive-letter and UNC ids normalize host-independently and are covered here; the
 * Windows PTY lifecycle behind them is not.
 */

const GIT_REPO_ID = 'repo-git'
const GIT_ROOT_PATH = '/tmp/ns/checkout'
const GIT_ROOT_ID = `${GIT_REPO_ID}::${GIT_ROOT_PATH}`
const GIT_CHILD_PATH = `${GIT_ROOT_PATH}/.claude/worktrees/child`
const GIT_CHILD_ID = `${GIT_REPO_ID}::${GIT_CHILD_PATH}`

const FOLDER_REPO_ID = 'repo-folder'
const FOLDER_PATH = '/tmp/ns/folder'
const FOLDER_ROOT_ID = `${FOLDER_REPO_ID}::${FOLDER_PATH}`
const FOLDER_A = `${FOLDER_ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const FOLDER_B = `${FOLDER_ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`

// Same directory, re-added as a second project: only the repo id differs.
const ALIAS_REPO_ID = 'repo-folder-alias'
const ALIAS_ID = `${ALIAS_REPO_ID}::${FOLDER_PATH}`

const PTY_GIT_ROOT = `${GIT_ROOT_ID}@@pty-git-root`
const PTY_GIT_CHILD = `${GIT_CHILD_ID}@@pty-git-child`
const PTY_A = `${FOLDER_A}@@pty-a`
const PTY_B = `${FOLDER_B}@@pty-b`
const PTY_FOLDER_ROOT = `${FOLDER_ROOT_ID}@@pty-folder-root`
const PTY_ALIAS = `${ALIAS_ID}@@pty-alias`
const PTY_FLOATING = 'floating-pty'

const LEAF_A = 'a1111111-1111-4111-8111-111111111111'
const LEAF_B = 'b2222222-2222-4222-8222-222222222222'

const REPOS = [
  { id: GIT_REPO_ID, path: GIT_ROOT_PATH, displayName: 'checkout', badgeColor: 'blue', addedAt: 1 },
  {
    id: FOLDER_REPO_ID,
    path: FOLDER_PATH,
    displayName: 'folder',
    badgeColor: 'green',
    addedAt: 2,
    kind: 'folder'
  },
  {
    id: ALIAS_REPO_ID,
    path: FOLDER_PATH,
    displayName: 'folder-alias',
    badgeColor: 'red',
    addedAt: 3,
    kind: 'folder'
  }
] as const

const ALL_WORKSPACE_IDS = [GIT_ROOT_ID, GIT_CHILD_ID, FOLDER_ROOT_ID, FOLDER_A, FOLDER_B, ALIAS_ID]

type ControllerSession = {
  id: string
  worktreeId?: string
  cwd?: string
  title?: string
  incarnationId?: string
  terminalHandle?: string
}

type RuntimeInternals = {
  buildResolvedWorktreeFromId: (worktreeId: string) => unknown
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId?: string | null
  ) => Promise<{ livePtyIds: Set<string> } | null>
  getLivePtyIdsForWorktree: (worktreeId: string) => Set<string>
  hasExactPersistedTerminalSurfaceIdentity: (expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }) => boolean
  ptysById: Map<string, { worktreeId: string; connected: boolean }>
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: Record<string, unknown>) => unknown
}

function createRuntimeInternals(options: {
  session?: WorkspaceSessionState
  sessions?: ControllerSession[]
}): RuntimeInternals {
  const meta = Object.fromEntries(ALL_WORKSPACE_IDS.map((id) => [id, { hostId: 'local' }]))
  const store = {
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: (worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getWorkspaceSession: () => options.session ?? getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  } as never
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => options.sessions ?? []
  } as never)
  return runtime as unknown as RuntimeInternals
}

function resolveWorktrees(internals: RuntimeInternals, ids: readonly string[]): unknown[] {
  return ids.map((id) => internals.buildResolvedWorktreeFromId(id))
}

/** Persisted layout binding each folder sibling's own PTY to its own tab and leaf. */
function persistedFolderSiblingSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [FOLDER_A]: [{ id: 'tab-a', worktreeId: FOLDER_A, title: 'A' }],
      [FOLDER_B]: [{ id: 'tab-b', worktreeId: FOLDER_B, title: 'B' }]
    } as never,
    terminalLayoutsByTabId: {
      'tab-a': { root: null, activeLeafId: LEAF_A, ptyIdsByLeafId: { [LEAF_A]: PTY_A } },
      'tab-b': { root: null, activeLeafId: LEAF_B, ptyIdsByLeafId: { [LEAF_B]: PTY_B } }
    } as never,
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey('tab-a', LEAF_A)]: 'inc-a',
      [makePaneKey('tab-b', LEAF_B)]: 'inc-b'
    }
  }
}

describe('workspace namespaces keep terminal identity host-local and per-workspace', () => {
  describe('git worktree namespace', () => {
    it('binds a nested worktree PTY to the nested worktree, not the targeted parent', async () => {
      // cwd alone cannot separate a parent checkout from a worktree nested inside it.
      const internals = createRuntimeInternals({
        sessions: [{ id: 'unattributed-pty', cwd: `${GIT_CHILD_PATH}/src`, title: 'child work' }]
      })
      const resolved = resolveWorktrees(internals, [GIT_ROOT_ID, GIT_CHILD_ID])

      const scopedToParent = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        GIT_ROOT_ID
      )
      const scopedToChild = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        GIT_CHILD_ID
      )

      expect([...(scopedToParent?.livePtyIds ?? [])]).toEqual([])
      expect([...(scopedToChild?.livePtyIds ?? [])]).toEqual(['unattributed-pty'])
      expect(internals.ptysById.get('unattributed-pty')?.worktreeId).toBe(GIT_CHILD_ID)
    })

    it('keeps a checkout and the worktree nested inside it in separate namespaces', async () => {
      const internals = createRuntimeInternals({
        sessions: [
          { id: PTY_GIT_ROOT, worktreeId: GIT_ROOT_ID, cwd: GIT_ROOT_PATH, title: 'git' },
          { id: PTY_GIT_CHILD, worktreeId: GIT_CHILD_ID, cwd: GIT_CHILD_PATH, title: 'child' }
        ]
      })
      const resolved = resolveWorktrees(internals, [GIT_ROOT_ID, GIT_CHILD_ID])

      await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolved)

      expect(internals.ptysById.get(PTY_GIT_ROOT)?.worktreeId).toBe(GIT_ROOT_ID)
      expect(internals.ptysById.get(PTY_GIT_CHILD)?.worktreeId).toBe(GIT_CHILD_ID)
      expect([...internals.getLivePtyIdsForWorktree(GIT_ROOT_ID)]).toEqual([PTY_GIT_ROOT])
      expect([...internals.getLivePtyIdsForWorktree(GIT_CHILD_ID)]).toEqual([PTY_GIT_CHILD])
    })
  })

  describe('folder workspace namespace', () => {
    it('does not let the caller target stand in for an attributed PTY owner', async () => {
      const internals = createRuntimeInternals({
        sessions: [{ id: PTY_B, worktreeId: FOLDER_B, cwd: FOLDER_PATH, title: 'b' }]
      })
      const resolved = resolveWorktrees(internals, [FOLDER_A, FOLDER_B])

      await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolved)
      const scopedToA = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        FOLDER_A
      )

      expect([...(scopedToA?.livePtyIds ?? [])]).toEqual([])
      expect(internals.ptysById.get(PTY_B)?.worktreeId).toBe(FOLDER_B)
    })

    it('keeps each sibling terminal bound to its own workspace across a reconnect', async () => {
      const sessions: ControllerSession[] = [
        {
          id: PTY_A,
          worktreeId: FOLDER_A,
          cwd: FOLDER_PATH,
          title: 'a',
          incarnationId: 'inc-a',
          terminalHandle: 'term_a'
        },
        {
          id: PTY_B,
          worktreeId: FOLDER_B,
          cwd: FOLDER_PATH,
          title: 'b',
          incarnationId: 'inc-b',
          terminalHandle: 'term_b'
        }
      ]
      const internals = createRuntimeInternals({
        session: persistedFolderSiblingSession(),
        sessions
      })
      const resolved = resolveWorktrees(internals, [FOLDER_A, FOLDER_B])

      // Reconnect resync: each workspace re-lists the same controller inventory.
      const afterA = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        FOLDER_A
      )
      const afterB = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        FOLDER_B
      )

      expect([...(afterA?.livePtyIds ?? [])]).toEqual([PTY_A])
      expect([...(afterB?.livePtyIds ?? [])]).toEqual([PTY_B])
      expect(internals.ptysById.get(PTY_A)?.worktreeId).toBe(FOLDER_A)
      expect(internals.ptysById.get(PTY_B)?.worktreeId).toBe(FOLDER_B)
      expect(
        internals.hasExactPersistedTerminalSurfaceIdentity({
          worktreeId: FOLDER_B,
          tabId: 'tab-b',
          leafId: LEAF_B,
          ptyId: PTY_B,
          incarnationId: 'inc-b'
        })
      ).toBe(true)
      // A sibling must never satisfy the other's persisted surface identity.
      expect(
        internals.hasExactPersistedTerminalSurfaceIdentity({
          worktreeId: FOLDER_A,
          tabId: 'tab-b',
          leafId: LEAF_B,
          ptyId: PTY_B,
          incarnationId: 'inc-b'
        })
      ).toBe(false)
    })

    it('does not treat one directory as one namespace across two projects', async () => {
      // Same directory added twice: the ids differ only by the client's repo id.
      const internals = createRuntimeInternals({
        sessions: [
          { id: PTY_A, worktreeId: FOLDER_A, cwd: FOLDER_PATH, title: 'a' },
          { id: PTY_FOLDER_ROOT, worktreeId: FOLDER_ROOT_ID, cwd: FOLDER_PATH, title: 'root' },
          { id: PTY_ALIAS, worktreeId: ALIAS_ID, cwd: FOLDER_PATH, title: 'alias' }
        ]
      })
      const resolved = resolveWorktrees(internals, [FOLDER_A, FOLDER_B, FOLDER_ROOT_ID, ALIAS_ID])

      await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolved)

      expect(internals.ptysById.get(PTY_A)?.worktreeId).toBe(FOLDER_A)
      expect(internals.ptysById.get(PTY_FOLDER_ROOT)?.worktreeId).toBe(FOLDER_ROOT_ID)
      expect(internals.ptysById.get(PTY_ALIAS)?.worktreeId).toBe(ALIAS_ID)
      expect([...internals.getLivePtyIdsForWorktree(ALIAS_ID)]).toEqual([PTY_ALIAS])
      expect([...internals.getLivePtyIdsForWorktree(FOLDER_ROOT_ID)]).toEqual([PTY_FOLDER_ROOT])
      expect([...internals.getLivePtyIdsForWorktree(FOLDER_A)]).toEqual([PTY_A])
      expect([...internals.getLivePtyIdsForWorktree(FOLDER_B)]).toEqual([])
    })
  })

  describe('floating workspace namespace', () => {
    it('never lets a repo workspace claim a floating terminal or vice versa', async () => {
      const internals = createRuntimeInternals({
        sessions: [
          {
            id: PTY_FLOATING,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            cwd: FOLDER_PATH,
            title: 'floating'
          },
          { id: PTY_A, worktreeId: FOLDER_A, cwd: FOLDER_PATH, title: 'a' }
        ]
      })
      const resolved = resolveWorktrees(internals, [FOLDER_A, FOLDER_B])

      await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolved)
      const scopedToA = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        resolved,
        FOLDER_A
      )

      // The floating id carries no repo/path pair, so it can only equal itself.
      expect([...(scopedToA?.livePtyIds ?? [])]).toEqual([PTY_A])
      expect(internals.ptysById.get(PTY_FLOATING)?.worktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
      expect([...internals.getLivePtyIdsForWorktree(FLOATING_TERMINAL_WORKTREE_ID)]).toEqual([
        PTY_FLOATING
      ])
      expect([...internals.getLivePtyIdsForWorktree(FOLDER_A)]).toEqual([PTY_A])
    })

    it('does not resolve a floating terminal onto a workspace that shares its cwd', () => {
      const internals = createRuntimeInternals({})
      internals.recordPtyWorktree(PTY_FLOATING, FLOATING_TERMINAL_WORKTREE_ID, { connected: true })
      internals.recordPtyWorktree(PTY_A, FOLDER_A, { connected: true })

      expect([...internals.getLivePtyIdsForWorktree(FOLDER_ROOT_ID)]).toEqual([])
      expect([...internals.getLivePtyIdsForWorktree(FLOATING_TERMINAL_WORKTREE_ID)]).toEqual([
        PTY_FLOATING
      ])
    })
  })

  // Only the id-normalization half of the Windows namespaces is host-independent.
  // Spawning and reconnecting a real drive/UNC PTY still needs a Windows host.
  describe('drive-letter and UNC namespaces (id normalization only)', () => {
    it('folds drive spelling and WSL UNC aliases but keeps distinct roots apart', () => {
      const internals = createRuntimeInternals({})
      internals.recordPtyWorktree('pty-c', 'repo-win::C:\\ws\\proj', { connected: true })
      internals.recordPtyWorktree('pty-d', 'repo-win::D:\\ws\\proj', { connected: true })
      internals.recordPtyWorktree('pty-share', 'repo-win::\\\\server\\share\\proj', {
        connected: true
      })
      internals.recordPtyWorktree('pty-other-share', 'repo-win::\\\\server\\other\\proj', {
        connected: true
      })
      internals.recordPtyWorktree('pty-wsl', 'repo-win::\\\\wsl$\\Ubuntu\\home\\me', {
        connected: true
      })

      expect([...internals.getLivePtyIdsForWorktree('repo-win::c:/ws/proj')]).toEqual(['pty-c'])
      expect([...internals.getLivePtyIdsForWorktree('repo-win::D:/ws/proj')]).toEqual(['pty-d'])
      expect([...internals.getLivePtyIdsForWorktree('repo-win::\\\\server\\share\\proj')]).toEqual([
        'pty-share'
      ])
      expect([
        ...internals.getLivePtyIdsForWorktree('repo-win::\\\\wsl.localhost\\ubuntu\\home\\me')
      ]).toEqual(['pty-wsl'])
    })

    it('keeps a folder workspace instance on a drive path distinct from its root', () => {
      const driveRoot = 'repo-win::C:\\ws\\proj'
      const driveInstance = `${driveRoot}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}dddddddd-dddd-4ddd-8ddd-dddddddddddd`
      const internals = createRuntimeInternals({})
      internals.recordPtyWorktree('pty-drive-root', driveRoot, { connected: true })
      internals.recordPtyWorktree('pty-drive-instance', driveInstance, { connected: true })

      expect([...internals.getLivePtyIdsForWorktree(driveRoot)]).toEqual(['pty-drive-root'])
      expect([...internals.getLivePtyIdsForWorktree(driveInstance)]).toEqual(['pty-drive-instance'])
    })
  })
})
