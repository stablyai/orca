import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as issueCommandFile from '../issue-command-file'
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
  const commands = new RuntimeRepositoryIssueCommand({
    resolveRepo: async () => repo,
    getLocalGitArgs: () => []
  })

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
    mocks.remoteCheck.mockResolvedValue(['.orca/issue-command'])

    await commands.write(repo.id, 'local command')

    expect(mocks.requireGit).toHaveBeenCalledWith('conn-1')
    expect(mocks.remoteCheck).toHaveBeenCalledWith(repo.path, ['.orca/issue-command'])
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

describe('local issue command runtime routing', () => {
  it.each(['command', ' '])(
    'preserves local file writes with an unavailable runtime: %j',
    async (content) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-runtime-ignore-'))
      const repo = {
        id: 'repo-1',
        path: root,
        displayName: 'local',
        badgeColor: '#000',
        addedAt: 0
      }
      mkdirSync(join(root, '.orca'))
      writeFileSync(join(root, '.orca', 'issue-command'), 'old command\n')
      const getLocalGitArgs = vi.fn((): [] => {
        throw new Error('Project runtime requires repair')
      })
      const commands = new RuntimeRepositoryIssueCommand({
        resolveRepo: async () => repo,
        getLocalGitArgs
      })
      try {
        await commands.write(repo.id, content)
        if (content.trim()) {
          expect(readFileSync(join(root, '.orca', 'issue-command'), 'utf8')).toBe('command\n')
          expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.orca\n')
        } else {
          expect(existsSync(join(root, '.orca', 'issue-command'))).toBe(false)
          expect(existsSync(join(root, '.gitignore'))).toBe(false)
          expect(getLocalGitArgs).not.toHaveBeenCalled()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('forwards the resolved WSL options to the local writer', async () => {
    const repo = {
      id: 'local',
      path: '/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const write = vi.spyOn(issueCommandFile, 'writeIssueCommand').mockResolvedValue(undefined)
    const getLocalGitArgs = vi.fn((): [{ wslDistro: string }] => [{ wslDistro: 'Ubuntu' }])
    try {
      const commands = new RuntimeRepositoryIssueCommand({
        resolveRepo: async () => repo,
        getLocalGitArgs
      })
      await commands.write(repo.id, 'command')
      const options = write.mock.calls[0]?.[2]
      expect(typeof options).toBe('function')
      expect(typeof options === 'function' ? options() : options).toEqual({ wslDistro: 'Ubuntu' })
      expect(getLocalGitArgs).toHaveBeenCalledWith(repo)
      expect(write).toHaveBeenCalledExactlyOnceWith(repo.path, 'command', expect.any(Function))
    } finally {
      write.mockRestore()
    }
  })
})
