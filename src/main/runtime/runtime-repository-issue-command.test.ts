import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'

const mocks = vi.hoisted(() => ({
  localCheck: vi.fn(),
  remoteCheck: vi.fn(),
  requireGit: vi.fn(),
  fs: {
    createDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deletePath: vi.fn()
  }
}))

vi.mock('../git/check-ignored-paths', () => ({ checkIgnoredPaths: mocks.localCheck }))
vi.mock('../providers/ssh-git-dispatch', () => ({ requireSshGitProvider: mocks.requireGit }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: () => mocks.fs
}))

describe('remote issue command ignore rules', () => {
  const repo = {
    id: 'repo-ssh',
    path: '/remote/repo with spaces',
    displayName: 'remote',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: 'conn-1'
  }
  const commands = new RuntimeRepositoryIssueCommand({ resolveRepo: async () => repo })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireGit.mockReturnValue({ checkIgnoredPaths: mocks.remoteCheck })
    mocks.remoteCheck.mockResolvedValue([])
    mocks.fs.createDir.mockResolvedValue(undefined)
    mocks.fs.writeFile.mockResolvedValue(undefined)
    mocks.fs.deletePath.mockResolvedValue(undefined)
    mocks.fs.readFile.mockResolvedValue({ content: 'node_modules/\n', isBinary: false })
  })

  it('uses the remote ignore rules and leaves .gitignore untouched', async () => {
    mocks.remoteCheck.mockResolvedValue(['.orca'])

    await commands.write(repo.id, 'local command')

    expect(mocks.requireGit).toHaveBeenCalledWith('conn-1')
    expect(mocks.remoteCheck).toHaveBeenCalledWith(repo.path, ['.orca'])
    expect(mocks.localCheck).not.toHaveBeenCalled()
    expect(mocks.fs.readFile).not.toHaveBeenCalled()
    expect(mocks.fs.writeFile).toHaveBeenCalledExactlyOnceWith(
      `${repo.path}/.orca/issue-command`,
      'local command\n'
    )
  })

  it('adds the rule if the remote host does not ignore .orca', async () => {
    await commands.write(repo.id, 'local command')

    expect(mocks.fs.writeFile).toHaveBeenCalledWith(
      `${repo.path}/.gitignore`,
      'node_modules/\n.orca\n'
    )
    expect(mocks.localCheck).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'failed'])(
    'keeps the remote fallback when Git is %s',
    async (failure) => {
      if (failure === 'unavailable') {
        mocks.requireGit.mockImplementation(() => {
          throw new Error('remote Git unavailable')
        })
      } else {
        mocks.remoteCheck.mockRejectedValue(new Error('remote Git failed'))
      }

      await expect(commands.write(repo.id, 'local command')).resolves.toEqual({ ok: true })

      expect(mocks.localCheck).not.toHaveBeenCalled()
      expect(mocks.fs.writeFile).toHaveBeenCalledWith(
        `${repo.path}/.gitignore`,
        'node_modules/\n.orca\n'
      )
    }
  )

  it('does not inspect ignore rules when clearing an override', async () => {
    await commands.write(repo.id, ' ')

    expect(mocks.requireGit).not.toHaveBeenCalled()
    expect(mocks.fs.writeFile).not.toHaveBeenCalled()
    expect(mocks.fs.deletePath).toHaveBeenCalledWith(`${repo.path}/.orca/issue-command`, false)
  })
})
