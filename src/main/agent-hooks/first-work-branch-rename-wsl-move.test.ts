import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

const { gitExecFileAsyncMock, generateBranchNameMock, resolveTextGenerationParamsMock } =
  vi.hoisted(() => ({
    gitExecFileAsyncMock: vi.fn(),
    generateBranchNameMock: vi.fn(),
    resolveTextGenerationParamsMock: vi.fn()
  }))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: vi.fn(async () => 'you') }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveTextGenerationParams: resolveTextGenerationParamsMock
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../ipc/worktree-branch-name', () => ({
  computeBranchName: vi.fn((leaf: string) => `you/${leaf}`),
  getConfiguredBranchPrefix: vi.fn(() => 'you')
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'
import {
  FOLDER_WORKTREE_ID,
  REPO_ID,
  gitResponder,
  makeBranchRenameDeps,
  workingEvent
} from './first-work-branch-rename-test-harness'

const LOCAL_REPO: Repo = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0
}

function makeDeps(overrides: Partial<FirstWorkBranchRenameDeps> = {}) {
  return makeBranchRenameDeps(vi.fn, overrides)
}

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-rename-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced', {}, { repoIds: [REPO_ID] }))
  resetFirstWorkBranchRenameState()
  vi.clearAllMocks()
  resolveTextGenerationParamsMock.mockReturnValue({
    ok: true,
    params: { agentId: 'claude', model: 'm' }
  })
  generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
  gitExecFileAsyncMock.mockImplementation(
    gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: false })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('first-work rename while a WSL move takes the project', () => {
  it('backs off before any git command and keeps the rename pending', async () => {
    const { deps, setDisplayName, setRenameError } = makeDeps({
      getRepo: () => LOCAL_REPO
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalled()

    resetWslMoveFenceForTests()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['branch', '-m', 'you/fix-auth'], {
      cwd: '/repo/wt'
    })
    expect(setDisplayName).toHaveBeenCalled()
  })

  it('backs off when the move starts during generation', async () => {
    resetWslMoveFenceForTests()
    loadWslMoveFence(join(userDataPath, 'unused'))
    generateBranchNameMock.mockImplementation(async () => {
      loadWslMoveFence(userDataPath)
      return { success: false, error: 'boom' }
    })
    const { deps, setDisplayName, setRenameError } = makeDeps({ getRepo: () => LOCAL_REPO })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(generateBranchNameMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['branch', '-m']),
      expect.anything()
    )
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalled()
  })

  it('backs off when the move starts after generation but before git branch -m', async () => {
    resetWslMoveFenceForTests()
    loadWslMoveFence(join(userDataPath, 'unused'))
    let fenced = false
    const respond = gitResponder({
      currentBranch: 'you/Nautilus',
      hasUpstream: false
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'show-ref' && !fenced) {
        fenced = true
        loadWslMoveFence(userDataPath)
      }
      return respond(args)
    })
    const { deps, setDisplayName, setRenameError, renameWorktreeFolder } = makeDeps({
      getRepo: () => LOCAL_REPO
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(generateBranchNameMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['branch', '-m']),
      expect.anything()
    )
    expect(renameWorktreeFolder).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalled()

    resetWslMoveFenceForTests()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['branch', '-m', 'you/fix-auth'], {
      cwd: '/repo/wt'
    })
  })

  it('settles the rename but leaves the folder in place when the move starts during git branch -m', async () => {
    resetWslMoveFenceForTests()
    loadWslMoveFence(join(userDataPath, 'unused'))
    const respond = gitResponder({
      currentBranch: 'you/Nautilus',
      hasUpstream: false
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'branch' && args[1] === '-m') {
        loadWslMoveFence(userDataPath)
      }
      return respond(args)
    })
    const { deps, renameWorktreeFolder } = makeDeps({
      getRepo: () => LOCAL_REPO
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['branch', '-m', 'you/fix-auth'], {
      cwd: '/repo/wt'
    })
    expect(renameWorktreeFolder).not.toHaveBeenCalled()

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    const branchRenames = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'branch' && args[1] === '-m'
    )
    expect(branchRenames).toHaveLength(1)
  })

  it('renames a project the move is not taking', async () => {
    const { deps, setDisplayName } = makeDeps({
      getRepo: () => ({ ...LOCAL_REPO, id: 'other-repo' })
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(setDisplayName).toHaveBeenCalled()
  })

  it('leaves the same repo id on another host to its own host', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { deps, setDisplayName } = makeDeps({
      getRepo: () => ({ ...LOCAL_REPO, executionHostId: 'runtime:env-1' })
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(info).toHaveBeenCalledWith(expect.stringContaining('branch is owned by runtime:env-1'))
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('WSL move'))
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    info.mockRestore()
  })

  it('keeps a moving folder workspace title pending', async () => {
    let moving = true
    const { deps, setDisplayName, setRenameError } = makeDeps({
      resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
      getFolderWorkspacePath: () => '/workspace/platform',
      isPendingFirstAgentMessageRename: () => true,
      isFolderWorkspaceWslMoveBlocked: () => moving
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalled()
    moving = false
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
    expect(setDisplayName).toHaveBeenCalled()
  })
})
