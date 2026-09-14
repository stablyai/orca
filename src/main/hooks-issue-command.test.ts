import type * as GitRunner from './git/runner'

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  makeHookTestRepo,
  TEST_GITIGNORE_PATH,
  TEST_ISSUE_COMMAND_PATH,
  TEST_REPO_ORCA_YAML_PATH,
  TEST_REPO_PATH
} from './hooks-test-fixtures'

// Mock fs used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

vi.mock('./git/runner', async () => ({
  ...(await vi.importActual<typeof GitRunner>('./git/runner')),
  gitExecFileSync: gitExecFileSyncMock
}))

describe('readIssueCommand', () => {
  it('prefers the local override over the shared orca.yaml command', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_ISSUE_COMMAND_PATH || path === TEST_REPO_ORCA_YAML_PATH
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_ISSUE_COMMAND_PATH) {
        return 'local command\n'
      }
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./issue-command-file')
    expect(readIssueCommand(TEST_REPO_PATH)).toEqual({
      localContent: 'local command',
      sharedContent: 'shared command',
      effectiveContent: 'local command',
      localFilePath: TEST_ISSUE_COMMAND_PATH,
      source: 'local'
    })
  })

  it('falls back to the shared orca.yaml command when no local override exists', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === TEST_REPO_ORCA_YAML_PATH)
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./issue-command-file')
    expect(readIssueCommand(TEST_REPO_PATH)).toEqual({
      localContent: null,
      sharedContent: 'shared command',
      effectiveContent: 'shared command',
      localFilePath: TEST_ISSUE_COMMAND_PATH,
      source: 'shared'
    })
  })
})

describe('writeIssueCommand', () => {
  it('writes only the local override file and keeps .orca ignored locally', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_GITIGNORE_PATH || path === join(TEST_REPO_PATH, '.orca')
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_GITIGNORE_PATH) {
        return 'node_modules/\n'
      }
      return ''
    })

    const { writeIssueCommand } = await import('./issue-command-file')
    writeIssueCommand(TEST_REPO_PATH, 'local command')

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      TEST_GITIGNORE_PATH,
      'node_modules/\n.orca\n',
      'utf-8'
    )
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      TEST_ISSUE_COMMAND_PATH,
      'local command\n',
      'utf-8'
    )
  })

  it('deletes the local override when the override is cleared', async () => {
    const { writeIssueCommand } = await import('./issue-command-file')
    const fs = await import('node:fs')
    writeIssueCommand(TEST_REPO_PATH, '   ')

    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(TEST_ISSUE_COMMAND_PATH, {
      force: true
    })
  })
})

describe('createIssueCommandRunnerScript', () => {
  const makeRepo = () => makeHookTestRepo({ mode: 'auto', scripts: { setup: '', archive: '' } })

  it('writes a POSIX issue-command runner when a shebang declares bash and setup resolves to Git Bash', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\issue-command-runner.sh\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    writeFileSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createIssueCommandRunnerScript } = await import('./worktree-runner-script')
      const result = createIssueCommandRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        '#!/usr/bin/env bash\ngh issue view 42',
        undefined,
        { family: 'posix' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/issue-command-runner.sh'],
        { cwd: 'C:\\repo-worktree' }
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\issue-command-runner.sh',
        '#!/usr/bin/env bash\nset -e\ngh issue view 42\n',
        'utf-8'
      )
      expect(result.shell).toEqual({ family: 'posix' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps a plain issue command on the cmd runner under a Git Bash terminal', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\issue-command-runner.cmd\n')
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createIssueCommandRunnerScript } = await import('./worktree-runner-script')
      const result = createIssueCommandRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        'gh issue view 42',
        undefined,
        { family: 'posix' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/issue-command-runner.cmd'],
        { cwd: 'C:\\repo-worktree' }
      )
      // Why: the runner file is batch (.cmd) while the pane that launches it is still Git Bash.
      expect(result.shell).toEqual({ family: 'posix' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the cmd issue-command runner when no setup shell is resolved', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\issue-command-runner.cmd\n')
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createIssueCommandRunnerScript } = await import('./worktree-runner-script')
      const result = createIssueCommandRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        'gh issue view 42'
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/issue-command-runner.cmd'],
        { cwd: 'C:\\repo-worktree' }
      )
      expect(result.shell).toEqual({ family: 'cmd' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
