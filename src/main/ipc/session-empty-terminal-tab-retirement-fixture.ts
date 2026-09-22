import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { advanceTerminalTopologyRevision } from '../runtime/workspace-session-terminal-membership-authority'
import { retireEmptyTerminalTab } from './session-empty-terminal-tab-retirement'

export const EMPTY_TAB = '11111111-1111-4111-8111-111111111111'
export const EMPTY_LEAF = '22222222-2222-4222-8222-222222222222'
export const EMPTY_INCARNATION = '33333333-3333-4333-8333-333333333333'
export function createEmptyTabRetirementFixture(
  options: {
    folder?: boolean
    armed?: boolean
    host?: 'local' | 'ssh:remote' | 'runtime:foreign'
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-empty-tab-close-'))
  const dataFile = join(directory, 'state.json')
  const store = new Store({ dataFile })
  const path = join(directory, 'repo')
  store.addRepo({
    id: 'repo1',
    path,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1,
    executionHostId: options.host ?? 'local'
  })
  let worktreeId = `repo1::${path}`
  if (options.folder) {
    const folderPath = join(directory, 'folder')
    const group = store.createProjectGroup({
      name: 'Folder',
      parentPath: folderPath,
      createdFrom: 'manual'
    })
    const folder = store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath,
      connectionId: options.host === 'ssh:remote' ? 'remote' : null
    })
    worktreeId = `folder:${folder.id}`
  }
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: EMPTY_TAB,
          worktreeId,
          ptyId: null,
          title: 'Empty',
          customTitle: null,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      [EMPTY_TAB]: { root: null, activeLeafId: null, expandedLeafId: null }
    }
  }
  store.setWorkspaceSession(
    options.armed === false ? session : advanceTerminalTopologyRevision(session, worktreeId)
  )
  store.flushOrThrow()
  const runtime = new OrcaRuntimeService(store)
  const request = { worktreeId, tabId: EMPTY_TAB, createdAt: 1, generation: 0 }
  return {
    store,
    runtime,
    request,
    worktreeId,
    dataFile,
    hasTab: () =>
      store.getWorkspaceSession().tabsByWorktree[worktreeId]?.some((tab) => tab.id === EMPTY_TAB) ??
      false,
    close: () => retireEmptyTerminalTab(store, runtime, request),
    dispose: () => {
      store.flush()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
