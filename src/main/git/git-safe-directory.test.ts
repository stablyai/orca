import { afterEach, describe, expect, it, vi } from 'vitest'

const gitExecFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({
  gitExecFileSync: gitExecFileSyncMock
}))

import {
  formatGitDubiousOwnershipRemediation,
  getLocalGitRepoAccessBlocker,
  isGitDubiousOwnershipError
} from './git-safe-directory'

describe('git safe.directory / dubious ownership', () => {
  afterEach(() => {
    gitExecFileSyncMock.mockReset()
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
    const message = formatGitDubiousOwnershipRemediation('D:/workspace/$(open -a Calculator)')
    expect(message).toContain('D:/workspace/$(open -a Calculator)')
    expect(message).toContain('safe.directory')
    expect(message).toContain('git config --global --add safe.directory <path>')
    // Why: path must not appear inside a double-quoted shell command fragment.
    expect(message).not.toMatch(/safe\.directory "[^"]*\$\(/)
    expect(message).toContain('re-add')
  })

  it('ownership remediation still names the path on its own line', () => {
    const message = formatGitDubiousOwnershipRemediation('D:/workspace/example')
    expect(message).toContain('D:/workspace/example')
    expect(message).toContain('WSL')
  })

  it('returns null when Git can open the repo', () => {
    gitExecFileSyncMock.mockReturnValue('.git\n')
    expect(getLocalGitRepoAccessBlocker('D:/workspace/ok')).toBeNull()
    expect(gitExecFileSyncMock).toHaveBeenCalledWith(['rev-parse', '--git-dir'], {
      cwd: 'D:/workspace/ok'
    })
  })

  it('returns remediation when rev-parse fails for dubious ownership', () => {
    gitExecFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('fatal: detected dubious ownership in repository'), {
        stderr: "fatal: detected dubious ownership in repository at 'D:/workspace/example'"
      })
    })
    const blocker = getLocalGitRepoAccessBlocker('D:/workspace/example')
    expect(blocker).toContain('dubious ownership')
    expect(blocker).toContain('D:/workspace/example')
    expect(blocker).toContain('safe.directory')
  })

  it('does not block import for unrelated Git failures', () => {
    gitExecFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git'
      })
    })
    expect(getLocalGitRepoAccessBlocker('D:/not-a-repo')).toBeNull()
  })
})
