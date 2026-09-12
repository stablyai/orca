import { afterEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  formatGitDubiousOwnershipRemediation,
  getLocalGitRepoAccessBlocker,
  isGitDubiousOwnershipError
} from './git-safe-directory'

describe('git safe.directory / dubious ownership', () => {
  afterEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('classifies dubious ownership from stderr and message', () => {
    expect(
      isGitDubiousOwnershipError(
        Object.assign(new Error('fatal: detected dubious ownership in repository at X'), {
          stderr:
            "fatal: detected dubious ownership in repository at 'D:/workspace/example'\n" +
            'To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/workspace/example\n'
        })
      )
    ).toBe(true)
    expect(isGitDubiousOwnershipError(new Error('fatal: not a git repository'))).toBe(false)
  })

  it('formats a remediation that names the path without shell-quoted injection surface', () => {
    const message = formatGitDubiousOwnershipRemediation(
      'D:/workspace/$(open -a Calculator)/`touch owned`\nnext'
    )
    expect(message).not.toContain('$(open -a Calculator)')
    expect(message).not.toContain('`touch owned`')
    expect(message).not.toContain('\nnext')
    expect(message).toContain('\\u0024(open -a Calculator)')
    expect(message).toContain('\\u0060touch owned\\u0060\\nnext')
    expect(message).toContain('safe.directory')
    expect(message).toContain('git config --global --add safe.directory <path>')
    expect(message).toContain('re-add')
  })

  it('ownership remediation still names an ordinary path', () => {
    const message = formatGitDubiousOwnershipRemediation('D:/workspace/example')
    expect(message).toContain('D:/workspace/example')
    expect(message).toContain('WSL')
  })

  it('returns null when Git can open the repo', async () => {
    gitExecFileAsyncMock.mockResolvedValue('.git\n')
    await expect(getLocalGitRepoAccessBlocker('D:/workspace/ok')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', '--git-dir'], {
      cwd: 'D:/workspace/ok'
    })
  })

  it('returns remediation when rev-parse fails for dubious ownership', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('fatal: detected dubious ownership in repository'), {
        stderr: "fatal: detected dubious ownership in repository at 'D:/workspace/example'"
      })
    )
    const blocker = await getLocalGitRepoAccessBlocker('D:/workspace/example')
    expect(blocker).toContain('dubious ownership')
    expect(blocker).toContain('D:/workspace/example')
    expect(blocker).toContain('safe.directory')
  })

  it('does not block import for unrelated Git failures', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git'
      })
    )
    await expect(getLocalGitRepoAccessBlocker('D:/not-a-repo')).resolves.toBeNull()
  })
})
