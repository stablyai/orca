import { afterEach, expect, it, vi } from 'vitest'
import { resolveWindowsGitBashShellPath } from '../git-bash'
import { workspaceServerShellCommand } from './workspace-server-command'

vi.mock('../git-bash', () => ({ resolveWindowsGitBashShellPath: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('resolves the Git Bash setting before building the owned process spec', () => {
  const program = 'C:\\Program Files\\Git\\bin\\bash.exe'
  vi.mocked(resolveWindowsGitBashShellPath).mockReturnValue(program)
  expect(workspaceServerShellCommand('git-bash', 'npm run dev', 'win32')).toMatchObject({
    program,
    args: ['-lc', 'npm run dev']
  })
})

it.each(['git-bash', 'bash', 'bash.exe'])(
  'reports an unavailable Git Bash installation for %s instead of spawning an ambiguous launcher',
  (program) => {
    vi.mocked(resolveWindowsGitBashShellPath).mockReturnValue(null)
    expect(() => workspaceServerShellCommand(program, 'npm run dev', 'win32')).toThrow('Git Bash')
  }
)

it.each(['wsl', 'wsl.exe', 'C:\\Windows\\System32\\WSL.EXE'])(
  'refuses cross-host managed children for Windows shell %s before spawning',
  (program) => {
    expect(() => workspaceServerShellCommand(program, 'npm run dev', 'win32')).toThrow(
      'WSL Orca host'
    )
  }
)

it('keeps Linux-host shell execution independent of Windows settings resolution', () => {
  expect(workspaceServerShellCommand('/bin/bash', 'npm run dev', 'linux')).toEqual({
    program: '/bin/bash',
    args: ['-lc', 'npm run dev']
  })
  expect(resolveWindowsGitBashShellPath).not.toHaveBeenCalled()
})
