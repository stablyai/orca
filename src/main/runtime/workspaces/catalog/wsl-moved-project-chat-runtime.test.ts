// A chat in a project a WSL host now owns stays on this computer (owner decision, option C): the
// runtime still resolves its UNC folder (the launch directory attach, ensure and a restart resume
// read through `resolveWorkspacePath`), and publishing its tab persists through the move's freeze.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../persistence/persistence-test-harness'
import { makeTerminalTab } from '../../../persistence/persistence-session-fixtures'
import { wslMoveCutoverFixture as cutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import '../../orca-runtime'

import { runtimeHiddenRepos } from './runtime-visible-catalog'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'
const MOVED = `repo-1::${UNC}`

const HOST_ID = 'runtime:wsl-ubuntu' as const
const repo = (path: string, executionHostId?: typeof HOST_ID): Repo => ({
  id: 'repo-1',
  path,
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 0,
  ...(executionHostId ? { executionHostId } : {})
})

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-moved-chat-runtime-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
  store.addRepo(repo(UNC))
  store.addRepo(repo('/home/dev/repo-1', HOST_ID))
  const slept: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [MOVED]: [makeTerminalTab({ id: 'slept', ptyId: null, worktreeId: MOVED })] }
  }
  store.setWorkspaceSession(slept)
  seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('a chat in a project the WSL host now owns', () => {
  it('hides only the local row from clients, by host, while the host row stays listed', () => {
    const hidden = runtimeHiddenRepos(store)
    expect(hidden.hasWorktree({ repoId: 'repo-1', hostId: 'local' })).toBe(true)
    expect(hidden.hasWorktree({ repoId: 'repo-1', hostId: HOST_ID })).toBe(false)
  })
})
