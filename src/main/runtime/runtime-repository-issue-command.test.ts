import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as issueCommandFile from '../issue-command-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'

const mocks = vi.hoisted(() => ({ localCheck: vi.fn() }))

vi.mock('../git/check-ignored-paths', () => ({ checkIgnoredPaths: mocks.localCheck }))

describe('SSH issue command', () => {
  const repo = {
    id: 'repo-ssh',
    path: '/remote/repo',
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
  })

  it('reads as no command and never reads this machine', async () => {
    const read = vi.spyOn(issueCommandFile, 'readIssueCommand')
    await expect(commands.read(repo.id)).resolves.toEqual({
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '/remote/repo/.orca/issue-command',
      source: 'none'
    })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('drops a write instead of writing this machine', async () => {
    const write = vi.spyOn(issueCommandFile, 'writeIssueCommand')
    await expect(commands.write(repo.id, 'command')).resolves.toEqual({ ok: true })
    expect(write).not.toHaveBeenCalled()
    expect(mocks.localCheck).not.toHaveBeenCalled()
    write.mockRestore()
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
