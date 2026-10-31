// A chat in a project a WSL host now owns stays on this computer (owner decision, option C): the
// runtime still resolves its UNC folder (the launch directory attach, ensure and a restart resume
// read through `resolveWorkspacePath`), and publishing its tab persists through the move's freeze.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Store } from '../persistence'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { makeTerminalTab } from '../persistence/persistence-session-fixtures'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { OrcaRuntimeService } from './orca-runtime'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import { runtimeHiddenRepos } from './runtime-visible-catalog'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'
const MOVED = `repo-1::${UNC}`
const ON_HOST = 'repo-1::/home/dev/repo-1'
const HOST_ID = 'runtime:wsl-ubuntu' as const
const repo = (path: string, executionHostId?: typeof HOST_ID): Repo => ({
  id: 'repo-1',
  path,
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 0,
  ...(executionHostId ? { executionHostId } : {})
})
const resolved = (id: string, path: string, hostId: Repo['executionHostId']): ResolvedWorktree => ({
  id,
  repoId: 'repo-1',
  hostId: hostId ?? 'local',
  path,
  head: 'abc',
  branch: 'main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'repo-1',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  git: { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
})

class MovedProjectRuntime extends OrcaRuntimeService {
  protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    return {
      worktrees: [resolved(MOVED, UNC, undefined), resolved(ON_HOST, '/home/dev/repo-1', HOST_ID)],
      platformByRepoId: new Map()
    }
  }
}

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
  it('still resolves its UNC folder, the launch directory a resume uses', async () => {
    const runtime = new MovedProjectRuntime(store)
    const target = await runtime.resolveRuntimeFileTarget(`id:${MOVED}`)
    expect(target.worktree.path).toBe(UNC)
    expect(target.executionHostId).toBe('local')
  })

  it('hides only the local row from clients, by host, while the host row stays listed', () => {
    const hidden = runtimeHiddenRepos(store)
    expect(hidden.hasWorktree({ repoId: 'repo-1', hostId: 'local' })).toBe(true)
    expect(hidden.hasWorktree({ repoId: 'repo-1', hostId: HOST_ID })).toBe(false)
  })

  it('persists its revealed tab through the freeze and keeps the slept terminal as it was', async () => {
    const runtime = new MovedProjectRuntime(store)
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: MOVED,
      sessionId: 'chat-moved-0001',
      agent: 'codex',
      activate: true
    })
    const session = store.getWorkspaceSession()
    expect(
      session.unifiedTabs?.[MOVED]?.filter((tab) => tab.contentType === 'agent-session')
    ).toHaveLength(1)
    expect(session.tabsByWorktree[MOVED]?.map((tab) => tab.id)).toEqual(['slept'])
  })
})
