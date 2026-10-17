import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileCommandHost } from './file-command-host'

const mocks = vi.hoisted(() => ({
  resolvePath: vi.fn(),
  expectation: vi.fn(),
  requireLocalRoute: vi.fn(),
  getRepo: vi.fn(),
  runRepoFormatOnSave: vi.fn()
}))

vi.mock('./file-mutation-expectation', () => ({
  assertRuntimeFileMutationExpectation: mocks.expectation
}))
vi.mock('./file-target', () => ({
  resolveFileExplorerPath: mocks.resolvePath,
  requireLocalRuntimeFileRoute: mocks.requireLocalRoute
}))
vi.mock('../../format-on-save-repo', () => ({ runRepoFormatOnSave: mocks.runRepoFormatOnSave }))

import { RuntimeFileFormatting } from './file-format-on-save'

const host = {
  requireStore: () => ({ getRepo: mocks.getRepo }),
  resolveRuntimeFileTarget: vi.fn()
} as unknown as Pick<RuntimeFileCommandHost, 'requireStore' | 'resolveRuntimeFileTarget'>
const commands = new RuntimeFileFormatting(host)
const repo = { id: 'repo-1', formatOnSave: { enabled: true, command: 'fmt ${file}', include: [] } }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.resolvePath.mockResolvedValue({
    executionHostId: 'local',
    path: '/srv/repo/src/a.ts',
    worktree: { repoId: 'repo-1', path: '/srv/repo' }
  })
  mocks.getRepo.mockReturnValue(repo)
  mocks.runRepoFormatOnSave.mockResolvedValue({ status: 'completed' })
})

describe('formatFileExplorerFile', () => {
  it('formats the resolved host path with the command held by this server', async () => {
    await expect(
      commands.formatFileExplorerFile('id:wt', 'src/a.ts', 3, 'box', 'local')
    ).resolves.toEqual({ status: 'completed' })

    expect(mocks.expectation).toHaveBeenCalledWith('local', 'local', 'box', 3)
    expect(mocks.runRepoFormatOnSave).toHaveBeenCalledWith({
      repo,
      worktreePath: '/srv/repo',
      absoluteFilePath: '/srv/repo/src/a.ts'
    })
  })

  it('refuses a host expectation mismatch before running anything', async () => {
    mocks.expectation.mockImplementation(() => {
      throw new Error('Workspace host changed; refresh and try again')
    })

    await expect(commands.formatFileExplorerFile('id:wt', 'src/a.ts')).rejects.toThrow(
      'Workspace host changed'
    )
    expect(mocks.runRepoFormatOnSave).not.toHaveBeenCalled()
  })

  it('never runs the command here for a host this process does not execute', async () => {
    mocks.requireLocalRoute.mockImplementation(() => {
      throw new Error('Remote connection dropped.')
    })

    await expect(commands.formatFileExplorerFile('id:wt', 'src/a.ts')).rejects.toThrow(
      'Remote connection dropped'
    )
    expect(mocks.runRepoFormatOnSave).not.toHaveBeenCalled()
  })

  it('skips a worktree whose repo this server does not hold', async () => {
    mocks.getRepo.mockReturnValue(undefined)

    await expect(commands.formatFileExplorerFile('id:wt', 'src/a.ts')).resolves.toEqual({
      status: 'skipped',
      reason: 'not-configured'
    })
    expect(mocks.runRepoFormatOnSave).not.toHaveBeenCalled()
  })
})
