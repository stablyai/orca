import { describe, expect, it, vi } from 'vitest'
import { probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'

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
