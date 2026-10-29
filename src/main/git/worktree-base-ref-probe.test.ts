import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsync = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({ gitExecFileAsync }))

import { hasLocalWorktreeBaseRef, probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'

describe('probeWorktreeBaseRefPresence', () => {
  it('uses an exact show-ref probe and reports a present ref', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '' })

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/release/2026')).resolves.toBe(
      'present'
    )
    expect(runGit).toHaveBeenCalledWith([
      'show-ref',
      '--verify',
      '--quiet',
      '--',
      'refs/heads/release/2026'
    ])
  })

  it('treats show-ref exit 1 as an absent ref', async () => {
    const runGit = vi.fn().mockRejectedValue(Object.assign(new Error('missing ref'), { code: 1 }))

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/release/2026')).resolves.toBe(
      'absent'
    )
  })

  it('keeps repository and transport failures inconclusive', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not a git repository'), { code: 128 }))

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/release/2026')).resolves.toBe(
      'unknown'
    )
  })

  it('does not treat a string transport code as a missing ref', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connection lost'), { code: '1' }))

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/release/2026')).resolves.toBe(
      'unknown'
    )
  })

  it('does not execute malformed ref input', async () => {
    const runGit = vi.fn()

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/*')).resolves.toBe('unknown')
    expect(runGit).not.toHaveBeenCalled()
  })
})

describe('hasLocalWorktreeBaseRef', () => {
  const repoPath = String.raw`C:\workspace\repo`

  function resolveOnly(present: string[]): void {
    gitExecFileAsync.mockImplementation(async (args: string[]) => ({
      stdout: present.includes(args.at(-1)?.replace('^{commit}', '') ?? '') ? 'f'.repeat(40) : '',
      stderr: ''
    }))
  }

  beforeEach(() => {
    gitExecFileAsync.mockReset()
  })

  it('prefers the remote namespace for a slashed short name', async () => {
    resolveOnly(['refs/remotes/origin/main'])

    await expect(hasLocalWorktreeBaseRef(repoPath, 'origin/main')).resolves.toBe(true)
    expect(gitExecFileAsync).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      { cwd: repoPath }
    )
  })

  it('probes a bare commit id as an object, not as a ref', async () => {
    const sha = 'a'.repeat(40)
    resolveOnly([sha])

    await expect(hasLocalWorktreeBaseRef(repoPath, sha, { wslDistro: 'Ubuntu' })).resolves.toBe(
      true
    )
    expect(gitExecFileAsync).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      { cwd: repoPath, wslDistro: 'Ubuntu' }
    )
  })

  it('reports a base no namespace resolves as absent', async () => {
    resolveOnly([])

    await expect(hasLocalWorktreeBaseRef(repoPath, 'feature/topic')).resolves.toBe(false)
  })
})
