import { afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../../src/main/persistence/loading-store/store'
import {
  createTestStore,
  seedStore,
  makeWorktree
} from '../../../src/renderer/src/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../../src/renderer/src/store/slices/store-cascades-test-harness'
import { buildWorkspaceSessionPayload } from '../../../src/renderer/src/lib/workspace-session'
import { advanceTerminalTopologyRevision } from '../../../src/main/runtime/workspace-session-terminal-membership-authority'
import type { WorkspaceSessionState } from '../../../src/shared/workspace-session-state-types'

export const TAB = '11111111-1111-4111-8111-111111111111'
export const LEAF = '22222222-2222-4222-8222-222222222222'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    fn()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

export function fixture(
  kind: 'repo' | 'folder' = 'repo',
  host: 'local' | 'ssh:target' | 'runtime:other' = 'local',
  persist = true
) {
  const api = createStoreCascadesMockApi()
  const renderer = createTestStore()
  seedStore(renderer, {})
  const dir = mkdtempSync(join(tmpdir(), 'orca-unbound-close-'))
  const file = join(dir, 'orca-data.json')
  const main = new Store({ dataFile: file })
  const repo = { ...renderer.getState().repos[0], executionHostId: host }
  main.addRepo(repo)
  let worktree = `${repo.id}::/tmp/worktree`
  let folder
  if (kind === 'folder') {
    const group = main.createProjectGroup({
      name: 'Folder',
      parentPath: '/tmp/folder',
      createdFrom: 'manual'
    })
    folder = main.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/tmp/folder',
      connectionId: host === 'ssh:target' ? 'target' : null
    })
    folder = main.getFolderWorkspace(folder.id)!
    worktree = `folder:${folder.id}`
  }
  seedStore(renderer, {
    repos: [repo],
    activeRepoId: repo.id,
    activeWorktreeId: worktree,
    worktreesByRepo: {
      [repo.id]: [
        makeWorktree({ id: worktree, repoId: repo.id, path: '/tmp/worktree', hostId: host })
      ]
    },
    ...(folder ? { folderWorkspaces: [folder] } : {}),
    tabsByWorktree: { [worktree]: [] }
  })
  renderer.getState().createTab(worktree, undefined, undefined, { id: TAB, activate: false })
  if (persist) {
    main.setWorkspaceSession(
      advanceTerminalTopologyRevision(buildWorkspaceSessionPayload(renderer.getState()), worktree)
    )
  }
  const hasTab = () =>
    main.getWorkspaceSession().tabsByWorktree[worktree]?.some((row) => row.id === TAB) ?? false
  const close = () => renderer.getState().closeTab(TAB)
  const save = () => main.setWorkspaceSession(buildWorkspaceSessionPayload(renderer.getState()))
  const mutate = (update: (session: WorkspaceSessionState) => WorkspaceSessionState) =>
    main.setWorkspaceSession(
      advanceTerminalTopologyRevision(update(main.getWorkspaceSession()), worktree)
    )
  const rows = (
    update: (
      row: WorkspaceSessionState['tabsByWorktree'][string][number]
    ) => WorkspaceSessionState['tabsByWorktree'][string][number]
  ) =>
    mutate((session) => ({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktree]: session.tabsByWorktree[worktree].map(update)
      }
    }))
  cleanup.push(() => {
    main.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  return { api, renderer, main, file, worktree, hasTab, close, save, mutate, rows }
}
