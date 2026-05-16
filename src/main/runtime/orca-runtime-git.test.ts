import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type * as GitStatusModule from '../git/status'
import type * as CommitMessageTextGenerationModule from '../text-generation/commit-message-text-generation'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  getStagedCommitContext: vi.fn(),
  generateCommitMessageFromContext: vi.fn(),
  resolveCommitMessageSettings: vi.fn()
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  getStagedCommitContext: mocks.getStagedCommitContext
}))

vi.mock('../text-generation/commit-message-text-generation', async () => ({
  ...(await vi.importActual<typeof CommitMessageTextGenerationModule>(
    '../text-generation/commit-message-text-generation'
  )),
  generateCommitMessageFromContext: mocks.generateCommitMessageFromContext,
  resolveCommitMessageSettings: mocks.resolveCommitMessageSettings
}))

const tempDirs: string[] = []

function makeWorktree(path: string): ResolvedRuntimeGitWorktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    git: {
      path,
      branch: 'main',
      bare: false,
      detached: false,
      head: 'a'.repeat(40)
    }
  } as unknown as ResolvedRuntimeGitWorktree
}

function makeCommands(worktreePath: string): RuntimeGitCommands {
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('RuntimeGitCommands', () => {
  beforeEach(() => {
    mocks.getStagedCommitContext.mockReset()
    mocks.generateCommitMessageFromContext.mockReset()
    mocks.resolveCommitMessageSettings.mockReset()
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('rejects slash-only git mutation paths before they can target the worktree root', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)

    await expect(commands.bulkDiscardRuntimeGitPaths('id:wt-1', ['///'])).rejects.toThrow(
      'invalid_relative_path'
    )
    await expect(commands.discardRuntimeGitPath('id:wt-1', '///')).rejects.toThrow(
      'invalid_relative_path'
    )
  })

  it('prepares the selected local agent environment before generating commit messages', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const context = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    mocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params })
    mocks.getStagedCommitContext.mockResolvedValue(context)
    mocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update readme'
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () =>
        ({
          commitMessageAi: { enabled: true, agentId: 'codex' },
          agentCmdOverrides: {},
          enableGitHubAttribution: false
        }) as GlobalSettings,
      getCommitMessageAgentEnvironment: () => ({
        prepareForCodexLaunch: () => '/managed/codex-home'
      })
    })

    await expect(commands.generateRuntimeCommitMessage('id:wt-1')).resolves.toEqual({
      success: true,
      message: 'docs: update readme'
    })

    expect(mocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: worktreePath,
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })
})
