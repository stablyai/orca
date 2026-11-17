import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { findLink, findLinkForPane, writeLink } from './external-conversation-links'

const WORKTREE = 'repo-1::/work/a'
const TARGET = hostWorktreeTarget({ id: WORKTREE, hostId: 'local' })
const WORKSPACE = { worktreeId: WORKTREE, sshHostId: null }
const KEY = { source: 'slack', externalId: 'thread-1' } as const
const FIRST_PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const SECOND_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function realStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'orca-connector-links-'))
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'connector-links'
    )
  })
  cleanups.push(() => {
    store.freezeWrites()
    rmSync(directory, { recursive: true, force: true })
  })
  store.addRepo({
    id: 'repo-1',
    path: '/work',
    displayName: 'repo',
    badgeColor: 'gray',
    addedAt: 1
  })
  return store
}

function link(paneKey: string) {
  return { ...KEY, paneKey, agent: 'claude' as const, createdAt: 1 }
}

describe('external conversation link lookups', () => {
  it('follow relinks and removed workspaces across unrelated metadata writes', () => {
    const store = realStore()
    expect(findLinkForPane(store, FIRST_PANE)).toBeNull()

    writeLink(store, WORKSPACE, link(FIRST_PANE))
    expect(findLinkForPane(store, FIRST_PANE)).toEqual({
      workspace: WORKSPACE,
      link: link(FIRST_PANE)
    })
    expect(findLink(store, KEY)?.link.paneKey).toBe(FIRST_PANE)

    // A sort-stamp write leaves links alone; the relink after it must still be seen.
    store.setWorktreeMeta(TARGET, { lastActivityAt: 5 })
    expect(findLinkForPane(store, FIRST_PANE)?.link.paneKey).toBe(FIRST_PANE)

    writeLink(store, WORKSPACE, link(SECOND_PANE))
    expect(findLinkForPane(store, FIRST_PANE)).toBeNull()
    expect(findLink(store, KEY)?.link.paneKey).toBe(SECOND_PANE)

    store.removeWorktreeMeta(TARGET)
    expect(findLinkForPane(store, SECOND_PANE)).toBeNull()
    expect(findLink(store, KEY)).toBeNull()
  })

  it('follow folder relinks across folder writes that keep links', () => {
    const store = realStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: tmpdir(),
      createdFrom: 'folder-scan'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: group.id })
    const workspace = { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }
    writeLink(store, workspace, link(FIRST_PANE))
    expect(findLinkForPane(store, FIRST_PANE)).toEqual({ workspace, link: link(FIRST_PANE) })

    store.updateFolderWorkspace(folder.id, { lastActivityAt: 5 })
    expect(findLinkForPane(store, FIRST_PANE)?.link.paneKey).toBe(FIRST_PANE)

    writeLink(store, workspace, link(SECOND_PANE))
    expect(findLinkForPane(store, FIRST_PANE)).toBeNull()
    expect(findLink(store, KEY)?.link.paneKey).toBe(SECOND_PANE)
  })
})
