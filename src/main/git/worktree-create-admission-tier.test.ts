import { beforeEach, describe, expect, it, vi } from 'vitest'

type GitExec = (
  args: string[],
  options: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn<GitExec>())

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { addWorktree } from './worktree-add'
import { listWorktreesSharedStrict } from './worktree-scan-cache'
import { finalizePreparedWorktree } from './worktree-create-preparation'

const HEAD = 'a'.repeat(40)

/** Options every call to `git` carried, keyed by the subcommand the args name. */
function optionsForCommand(match: string): Record<string, unknown>[] {
  return gitExecFileAsyncMock.mock.calls
    .filter((call) => call[0].join(' ').includes(match))
    .map((call) => call[1])
}

describe('worktree create admission tier', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: HEAD, stderr: '' })
  })

  it('runs the create add at the tier the caller asked for', async () => {
    await addWorktree('/repo', '/repo-wt', 'feature', 'main', false, false, {
      admissionTier: 'interactive'
    })

    const addOptions = optionsForCommand('worktree add')
    expect(addOptions).toHaveLength(1)
    expect(addOptions[0]).toMatchObject({
      cwd: '/repo',
      admissionTier: 'interactive'
    })
  })

  it('runs the post-add listing at the tier the caller asked for', async () => {
    await listWorktreesSharedStrict('/repo', { admissionTier: 'interactive' })

    const listOptions = optionsForCommand('worktree list')
    expect(listOptions.length).toBeGreaterThan(0)
    for (const options of listOptions) {
      expect(options).toMatchObject({ admissionTier: 'interactive' })
    }
  })

  it('runs the prepared-checkout finalize at the tier the caller asked for', async () => {
    await finalizePreparedWorktree('/repo', '/prepared', '/repo-wt', 'feature', 'main', false, {
      admissionTier: 'interactive'
    })

    for (const match of ['worktree move', 'checkout --no-track', 'worktree unlock']) {
      const options = optionsForCommand(match)
      expect(options, match).toHaveLength(1)
      expect(options[0], match).toMatchObject({ admissionTier: 'interactive' })
    }
  })

  it('leaves a command with no tier at the scheduler default', async () => {
    await addWorktree('/repo', '/repo-wt', 'feature', 'main')

    expect(optionsForCommand('worktree add')[0]).not.toHaveProperty('admissionTier')
  })
})
