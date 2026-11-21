import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import {
  resetWslClaudeProjectsRootCacheForTests,
  resolveWslClaudeProjectsDir
} from './wsl-claude-projects-root'

afterEach(() => {
  resetWslClaudeProjectsRootCacheForTests()
  runProcessMock.mockReset()
})

describe('WSL Claude projects realpath read', () => {
  it('passes the projects path through --exec so wsl.exe cannot expand $1', async () => {
    runProcessMock.mockResolvedValue({ code: 0, stdout: '/home/ada/dotfiles/.claude/projects\n' })
    await resolveWslClaudeProjectsDir({
      homeDir: '\\\\wsl.localhost\\Ubuntu\\home\\ada',
      platform: 'win32',
      directoryExists: async () => false
    })
    const args: string[] = runProcessMock.mock.calls[0][0].args
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'sh'])
    expect(args).not.toContain('--')
    expect(args.at(-1)).toBe('/home/ada/.claude/projects')
  })

  it('retries after wsl.exe fails instead of remembering an empty answer', async () => {
    runProcessMock.mockResolvedValue({ code: 1, stdout: '' })
    const args = {
      homeDir: '\\\\wsl.localhost\\Ubuntu\\home\\ada',
      platform: 'win32' as const,
      useProcessCache: true,
      directoryExists: async () => false
    }
    await resolveWslClaudeProjectsDir(args)
    await resolveWslClaudeProjectsDir(args)
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })
})
