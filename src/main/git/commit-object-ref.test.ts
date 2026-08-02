import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  hasCommitObjectViaGitExec,
  hasLocalCommitObject,
  isFullGitObjectId
} from './commit-object-ref'

describe('commit object refs', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('recognizes only complete git object IDs', () => {
    expect(isFullGitObjectId('a'.repeat(40))).toBe(true)
    expect(isFullGitObjectId('A'.repeat(40))).toBe(true)
    expect(isFullGitObjectId('abc123')).toBe(false)
    expect(isFullGitObjectId('origin/main')).toBe(false)
    expect(isFullGitObjectId('g'.repeat(40))).toBe(false)
  })

  it('verifies full commit objects and rejects missing objects', async () => {
    const gitExec = vi.fn().mockResolvedValue({ stdout: 'a'.repeat(40), stderr: '' })

    await expect(hasCommitObjectViaGitExec(gitExec, 'a'.repeat(40))).resolves.toBe(true)

    expect(gitExec).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--quiet',
      `${'a'.repeat(40)}^{commit}`
    ])

    gitExec.mockRejectedValueOnce(new Error('missing'))
    await expect(hasCommitObjectViaGitExec(gitExec, 'b'.repeat(40))).resolves.toBe(false)
  })

  it('does not shell out for branch names or short SHAs', async () => {
    const gitExec = vi.fn()

    await expect(hasCommitObjectViaGitExec(gitExec, 'abc123')).resolves.toBe(false)
    await expect(hasCommitObjectViaGitExec(gitExec, 'origin/main')).resolves.toBe(false)

    expect(gitExec).not.toHaveBeenCalled()
  })

  it('checks local commit objects in the target repo path', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'a'.repeat(40), stderr: '' })

    await expect(hasLocalCommitObject('/repo', 'a'.repeat(40))).resolves.toBe(true)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${'a'.repeat(40)}^{commit}`],
      { cwd: '/repo' }
    )
  })
})
