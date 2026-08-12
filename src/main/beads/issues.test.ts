import { beforeEach, describe, expect, it, vi } from 'vitest'

const { commandExecFileAsyncMock, gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(
  () => ({
    commandExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    getSshGitProviderMock: vi.fn()
  })
)

vi.mock('../git/runner', () => ({
  commandExecFileAsync: commandExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  extractExecError: (err: unknown) => {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return { stderr: e.stderr ?? e.message ?? String(err), stdout: e.stdout ?? '' }
  }
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 1)
}))

import {
  _resetBdVersionCache,
  isBdNotInitializedOutput,
  isSupportedBdVersion,
  parseBdVersionLine
} from './client'
import {
  clampBeadsIssueLimit,
  getBeadsIssue,
  isBeadsIssueStatus,
  listBeadsIssues,
  resolveBeadsListPlan,
  updateBeadsIssueStatus
} from './issues'

const LOCAL_TARGET = { repoPath: '/repo', connectionId: null }

const RAW_ISSUE = {
  id: 'probe-a1',
  title: 'First issue',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  owner: 'creator@example.com',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  dependency_count: 0,
  dependent_count: 1,
  comment_count: 0
}

function queueVersionOk(): void {
  commandExecFileAsyncMock.mockResolvedValueOnce({
    stdout: 'bd version 1.1.2 (Homebrew)\n',
    stderr: ''
  })
}

beforeEach(() => {
  commandExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  getSshGitProviderMock.mockReset()
  _resetBdVersionCache()
  delete process.env.BEADS_ACTOR
})

describe('bd version gate', () => {
  it('parses the bd version line', () => {
    expect(parseBdVersionLine('bd version 1.1.2 (Homebrew)')).toBe('1.1.2')
    expect(parseBdVersionLine('garbage')).toBeNull()
  })

  it('gates on >= 1.1.0', () => {
    expect(isSupportedBdVersion('1.1.0')).toBe(true)
    expect(isSupportedBdVersion('1.1.2')).toBe(true)
    expect(isSupportedBdVersion('2.0.0')).toBe(true)
    expect(isSupportedBdVersion('1.0.9')).toBe(false)
    expect(isSupportedBdVersion('0.9.0')).toBe(false)
  })

  it('recognizes the not-initialized error', () => {
    expect(isBdNotInitializedOutput('Error: no beads database found\nHint: run bd init')).toBe(true)
    expect(isBdNotInitializedOutput('some other failure')).toBe(false)
  })
})

describe('clampBeadsIssueLimit', () => {
  it('defaults and clamps to 200', () => {
    expect(clampBeadsIssueLimit(undefined)).toBe(200)
    expect(clampBeadsIssueLimit(9999)).toBe(200)
    expect(clampBeadsIssueLimit(0)).toBe(1)
    expect(clampBeadsIssueLimit(50)).toBe(50)
  })
})

describe('resolveBeadsListPlan', () => {
  it('maps legacy presets when no query-filter params are present', () => {
    expect(resolveBeadsListPlan({ preset: 'open' })).toEqual({ scope: 'open', assignee: null })
    expect(resolveBeadsListPlan({ preset: 'assigned' })).toEqual({
      scope: 'open',
      assignee: '@me'
    })
    expect(resolveBeadsListPlan({ preset: 'ready' })).toEqual({ scope: 'ready', assignee: null })
    expect(resolveBeadsListPlan({})).toEqual({ scope: 'open', assignee: null })
  })

  it('lets the query-filter params override the preset entirely', () => {
    expect(resolveBeadsListPlan({ preset: 'assigned', statusScope: 'all' })).toEqual({
      scope: 'all',
      assignee: null
    })
    expect(resolveBeadsListPlan({ preset: 'open', assignee: 'alice' })).toEqual({
      scope: 'open',
      assignee: 'alice'
    })
  })
})

describe('listBeadsIssues', () => {
  it('lists open issues sorted by updated_at desc', async () => {
    queueVersionOk()
    const newer = { ...RAW_ISSUE, id: 'probe-b2', updated_at: '2026-02-01T00:00:00Z' }
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([RAW_ISSUE, newer]),
      stderr: ''
    })

    const result = await listBeadsIssues(LOCAL_TARGET, { preset: 'open', limit: 200 })

    expect(result.status).toEqual({
      bdInstalled: true,
      bdVersion: '1.1.2',
      versionSupported: true,
      initialized: true
    })
    expect(result.issues.map((issue) => issue.id)).toEqual(['probe-b2', 'probe-a1'])
    // owner is the creator, never surfaced as assignee.
    expect(result.issues[1].assignee).toBeUndefined()
    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['list', '--json', '-n', '200'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('maps a not-initialized failure to initialized:false instead of an error', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'Error: no beads database found\n',
      stdout: ''
    })

    const result = await listBeadsIssues(LOCAL_TARGET, { preset: 'open', limit: 200 })

    expect(result.issues).toEqual([])
    expect(result.status.initialized).toBe(false)
    expect(result.status.bdInstalled).toBe(true)
  })

  it('reports bd as not installed when the binary is missing', async () => {
    commandExecFileAsyncMock.mockRejectedValueOnce({ code: 'ENOENT', message: 'spawn bd ENOENT' })

    const result = await listBeadsIssues(LOCAL_TARGET, { preset: 'open', limit: 200 })

    expect(result.status).toEqual({
      bdInstalled: false,
      bdVersion: null,
      versionSupported: false,
      initialized: false
    })
    expect(result.issues).toEqual([])
  })

  it('returns no issues for an unsupported bd version', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'bd version 1.0.0\n', stderr: '' })

    const result = await listBeadsIssues(LOCAL_TARGET, { preset: 'open', limit: 200 })

    expect(result.status.versionSupported).toBe(false)
    expect(result.issues).toEqual([])
    // Only the version probe ran — no list attempt against an unsupported bd.
    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('passes the BEADS_ACTOR env value for the assigned preset', async () => {
    process.env.BEADS_ACTOR = 'octocat'
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    await listBeadsIssues(LOCAL_TARGET, { preset: 'assigned', limit: 100 })

    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['list', '--json', '-n', '100', '-a', 'octocat'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('falls back to git config user.name for the assigned actor', async () => {
    queueVersionOk()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'Config Name\n', stderr: '' })
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    await listBeadsIssues(LOCAL_TARGET, { preset: 'assigned', limit: 200 })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', 'user.name'],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['list', '--json', '-n', '200', '-a', 'Config Name'],
      expect.anything()
    )
  })

  it('routes ready through bd ready and truncates client-side', async () => {
    queueVersionOk()
    const issues = Array.from({ length: 3 }, (_, index) => ({
      ...RAW_ISSUE,
      id: `probe-${index}`,
      updated_at: `2026-01-0${index + 1}T00:00:00Z`
    }))
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify(issues), stderr: '' })

    const result = await listBeadsIssues(LOCAL_TARGET, { preset: 'ready', limit: 2 })

    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['ready', '--json'],
      expect.anything()
    )
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0].id).toBe('probe-2')
  })

  it('adds --all for the all scope so closed issues are included (bd 1.1.2 probe)', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    await listBeadsIssues(LOCAL_TARGET, { statusScope: 'all', limit: 150 })

    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['list', '--json', '--all', '-n', '150'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('routes the ready scope through bd ready', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    await listBeadsIssues(LOCAL_TARGET, { statusScope: 'ready', limit: 200 })

    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['ready', '--json'],
      expect.anything()
    )
  })

  it('resolves assignee:@me to the host actor and passes others verbatim', async () => {
    process.env.BEADS_ACTOR = 'octocat'
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })
    await listBeadsIssues(LOCAL_TARGET, { statusScope: 'all', assignee: '@me', limit: 200 })
    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['list', '--json', '--all', '-n', '200', '-a', 'octocat'],
      expect.anything()
    )

    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })
    _resetBdVersionCache()
    await listBeadsIssues(LOCAL_TARGET, { statusScope: 'open', assignee: 'alice', limit: 200 })
    expect(commandExecFileAsyncMock).toHaveBeenLastCalledWith(
      'bd',
      ['list', '--json', '-n', '200', '-a', 'alice'],
      expect.anything()
    )
  })

  it('runs bd on the SSH host for connection-backed repos', async () => {
    const execNonInteractive = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'bd version 1.1.2\n',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([RAW_ISSUE]),
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    getSshGitProviderMock.mockReturnValue({
      execNonInteractive,
      getHostPlatform: () => null
    })

    const result = await listBeadsIssues(
      { repoPath: '/remote/repo', connectionId: 'ssh-1' },
      { preset: 'open', limit: 200 }
    )

    expect(execNonInteractive).toHaveBeenCalledWith('bd', ['version'], '/remote/repo', 15_000)
    expect(execNonInteractive).toHaveBeenCalledWith(
      'bd',
      ['list', '--json', '-n', '200'],
      '/remote/repo',
      15_000
    )
    expect(result.issues).toHaveLength(1)
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('degrades to a typed unavailable status when the SSH connection is down', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    const result = await listBeadsIssues(
      { repoPath: '/remote/repo', connectionId: 'ssh-1' },
      { preset: 'open', limit: 200 }
    )

    expect(result.issues).toEqual([])
    expect(result.status.bdInstalled).toBe(false)
  })
})

describe('getBeadsIssue', () => {
  it('unwraps the bd show array payload', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([RAW_ISSUE]),
      stderr: ''
    })

    const result = await getBeadsIssue(LOCAL_TARGET, 'probe-a1')

    expect(result.issue?.id).toBe('probe-a1')
    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['show', 'probe-a1', '--json'],
      expect.anything()
    )
  })

  it('returns null when a missing id exits 1 (bd 1.1.2 behavior)', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'Error fetching nope-1: no issue found matching nope-1\n',
      stdout: JSON.stringify({ error: 'no issues found matching the provided IDs' })
    })

    const result = await getBeadsIssue(LOCAL_TARGET, 'nope-1')

    expect(result.issue).toBeNull()
  })

  it('still throws on genuinely unexpected bd show failures', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'panic: database corrupted\n',
      stdout: ''
    })

    await expect(getBeadsIssue(LOCAL_TARGET, 'probe-a1')).rejects.toThrow('bd show failed')
  })

  it('rejects ids bd would parse as flags without spawning', async () => {
    const result = await getBeadsIssue(LOCAL_TARGET, '--all')

    expect(result.issue).toBeNull()
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })
})

describe('isBeadsIssueStatus', () => {
  it('accepts only the five bd statuses', () => {
    expect(isBeadsIssueStatus('in_progress')).toBe(true)
    expect(isBeadsIssueStatus('closed')).toBe(true)
    expect(isBeadsIssueStatus('pinned')).toBe(false)
    expect(isBeadsIssueStatus(undefined)).toBe(false)
  })
})

describe('updateBeadsIssueStatus', () => {
  it('runs bd update then reads the full issue back via bd show', async () => {
    queueVersionOk()
    // bd 1.1.2 update payload omits the count fields that show includes.
    const partial = { ...RAW_ISSUE, status: 'in_progress' }
    delete (partial as Record<string, unknown>).dependent_count
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([partial]),
      stderr: ''
    })
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ ...RAW_ISSUE, status: 'in_progress' }]),
      stderr: ''
    })

    const result = await updateBeadsIssueStatus(LOCAL_TARGET, 'probe-a1', 'in_progress')

    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'bd',
      ['update', 'probe-a1', '--status', 'in_progress', '--json'],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(commandExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      'bd',
      ['show', 'probe-a1', '--json'],
      expect.anything()
    )
    expect(result.issue?.status).toBe('in_progress')
    expect(result.issue?.dependentCount).toBe(1)
    expect(result.status.initialized).toBe(true)
  })

  it('falls back to the bd update payload when the read-back fails', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ ...RAW_ISSUE, status: 'closed' }]),
      stderr: ''
    })
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'Error fetching probe-a1: no issue found matching probe-a1\n',
      stdout: ''
    })

    const result = await updateBeadsIssueStatus(LOCAL_TARGET, 'probe-a1', 'closed')

    expect(result.issue?.status).toBe('closed')
  })

  it('maps a not-initialized failure to a typed status instead of throwing', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'Error: no beads database found\n',
      stdout: ''
    })

    const result = await updateBeadsIssueStatus(LOCAL_TARGET, 'probe-a1', 'closed')

    expect(result.issue).toBeNull()
    expect(result.status.bdInstalled).toBe(true)
    expect(result.status.initialized).toBe(false)
  })

  it('maps a missing bd binary to a typed status instead of throwing', async () => {
    commandExecFileAsyncMock.mockRejectedValueOnce({ code: 'ENOENT', message: 'spawn bd ENOENT' })

    const result = await updateBeadsIssueStatus(LOCAL_TARGET, 'probe-a1', 'closed')

    expect(result.issue).toBeNull()
    expect(result.status.bdInstalled).toBe(false)
    // Only the version probe ran — no mutation attempt against a missing bd.
    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('throws on a genuine bd update failure such as an unknown id', async () => {
    queueVersionOk()
    commandExecFileAsyncMock.mockRejectedValueOnce({
      code: 1,
      stderr: 'Error resolving nope-123: no issue found matching "nope-123"\n',
      stdout: ''
    })

    await expect(updateBeadsIssueStatus(LOCAL_TARGET, 'nope-123', 'closed')).rejects.toThrow(
      'bd update failed'
    )
  })

  it('rejects ids bd would parse as flags without spawning', async () => {
    await expect(updateBeadsIssueStatus(LOCAL_TARGET, '--all', 'closed')).rejects.toThrow(
      'implausible issue id'
    )
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('runs the mutation on the SSH host for connection-backed repos', async () => {
    const execNonInteractive = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'bd version 1.1.2\n',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ ...RAW_ISSUE, status: 'blocked' }]),
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ ...RAW_ISSUE, status: 'blocked' }]),
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    getSshGitProviderMock.mockReturnValue({
      execNonInteractive,
      getHostPlatform: () => null
    })

    const result = await updateBeadsIssueStatus(
      { repoPath: '/remote/repo', connectionId: 'ssh-1' },
      'probe-a1',
      'blocked'
    )

    expect(execNonInteractive).toHaveBeenCalledWith(
      'bd',
      ['update', 'probe-a1', '--status', 'blocked', '--json'],
      '/remote/repo',
      15_000
    )
    expect(result.issue?.status).toBe('blocked')
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
