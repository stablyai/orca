import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  closeTestStores,
  createSqliteTestStore,
  makeTerminalTab
} from '../../persistence-test-harness'
import { Store } from './store'

const HOST_ID = 'ssh:target-1'
const WORKTREE = 'repo-1::/srv/app'
const FOLDER_WORKTREE = 'folder:folder-1'
const TAB_ID = 'host-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'orca-host-before-unload-'))
  directories.push(directory)
  return createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
}

/** The renderer's host split leaves out terminal maps for a host with only editor tabs. */
function editorOnlySlice(worktreeId = WORKTREE): WorkspaceSessionState {
  const slice: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [worktreeId]: [
        { worktreeId, filePath: '/srv/app/a.ts', relativePath: 'a.ts', language: 'typescript' }
      ]
    }
  }
  Reflect.deleteProperty(slice, 'tabsByWorktree')
  Reflect.deleteProperty(slice, 'terminalLayoutsByTabId')
  return slice
}

describe('before-unload staging of an editor-only host slice', () => {
  it.each([
    [{}, WORKTREE],
    [{ 'repo-1': 1 }, WORKTREE],
    [{ 'repo-1': 1 }, FOLDER_WORKTREE]
  ])('saves the slice when the partition has topology revisions %j (%s)', (revisions, worktree) => {
    const store = openStore()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: revisions },
      HOST_ID
    )

    store.stageWorkspaceSessionBeforeUnload(editorOnlySlice(worktree), HOST_ID)

    const saved = store.getWorkspaceSession(HOST_ID)
    expect(saved.openFilesByWorktree?.[worktree]).toHaveLength(1)
    expect(saved.tabsByWorktree).toEqual({})
    expect(saved.terminalLayoutsByTabId).toEqual({})
  })

  it('accepts an older saved partition that is missing the terminal maps', () => {
    const store = openStore()
    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), terminalTopologyRevisionByRepoId: { 'repo-1': 1 } },
      HOST_ID
    )
    const older = store.getWorkspaceSession(HOST_ID)
    Reflect.deleteProperty(older, 'tabsByWorktree')
    Reflect.deleteProperty(older, 'terminalLayoutsByTabId')

    store.stageWorkspaceSessionBeforeUnload(editorOnlySlice(), HOST_ID)

    expect(store.getWorkspaceSession(HOST_ID).tabsByWorktree).toEqual({})
  })

  it('keeps fenced live terminal tabs the stale slice leaves out', () => {
    const store = openStore()
    const tab = makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE, ptyId: 'live-pty' })
    const layout = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'live-pty' }
    } as const
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [WORKTREE]: [tab] },
        terminalLayoutsByTabId: { [TAB_ID]: layout },
        terminalTopologyRevisionByRepoId: { 'repo-1': 1 }
      },
      HOST_ID
    )

    store.stageWorkspaceSessionBeforeUnload(editorOnlySlice(), HOST_ID)

    expect(store.getWorkspaceSession(HOST_ID)).toMatchObject({
      tabsByWorktree: { [WORKTREE]: [tab] },
      terminalLayoutsByTabId: { [TAB_ID]: layout }
    })
  })
})
