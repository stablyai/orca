import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from './runtime-client'
import { getBrowserWorktreeSelector } from './selectors'
import { buildWorktree, worktreeListFixture } from './test-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('browser worktree selection outside the caller checkout (#37899)', () => {
  it('uses the terminal worktree after the caller changes to a scratch directory', async () => {
    vi.stubEnv('ORCA_WORKTREE_ID', 'repo::/repo/caller')
    const client = new RuntimeClient('/tmp/orca-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockResolvedValue(
      worktreeListFixture([
        buildWorktree('/repo/caller', 'main'),
        buildWorktree('/repo/other', 'main')
      ])
    )

    expect(await getBrowserWorktreeSelector(new Map(), '/scratch', client)).toBe(
      'repo::/repo/caller'
    )
    expect(await getBrowserWorktreeSelector(new Map(), '/repo/other', client)).toBe(
      'id:repo::/repo/other'
    )
    expect(
      await getBrowserWorktreeSelector(
        new Map([['worktree', 'id:repo::/repo/explicit']]),
        '/scratch',
        client
      )
    ).toBe('id:repo::/repo/explicit')
  })

  it('uses the terminal folder workspace when there is no worktree identity', async () => {
    vi.stubEnv('ORCA_WORKTREE_ID', '')
    vi.stubEnv('ORCA_WORKSPACE_ID', 'folder:caller')
    const client = new RuntimeClient('/tmp/orca-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockResolvedValue(worktreeListFixture([]))

    expect(await getBrowserWorktreeSelector(new Map(), '/scratch', client)).toBe('folder:caller')
  })
})
