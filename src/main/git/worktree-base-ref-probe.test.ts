import { describe, expect, it, vi } from 'vitest'

const gitExecFileAsync = vi.hoisted(() => vi.fn())

vi.mock('./runner', () => ({ gitExecFileAsync }))

import { probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'

describe('probeWorktreeBaseRefPresence', () => {
  it('treats show-ref exit 1 as an absent ref', async () => {
    const runGit = vi.fn().mockRejectedValue(Object.assign(new Error('missing ref'), { code: 1 }))

    await expect(probeWorktreeBaseRefPresence(runGit, 'refs/heads/release/2026')).resolves.toBe(
      'absent'
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
