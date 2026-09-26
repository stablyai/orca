import { beforeEach, expect, it, vi } from 'vitest'

const gitExec = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ gitExecFileAsync: gitExec }))
vi.mock('./worktree-base-refresh', () => ({
  refreshLocalBaseRefForWorktreeCreate: vi.fn(),
  getLocalBaseRefUpdateSuggestionForWorktreeCreate: vi.fn()
}))
vi.mock('./status', () => ({ runWithGitReadCacheInvalidation: (run: () => unknown) => run() }))
vi.mock('./wsl-linked-worktree-git-routing', () => ({
  invalidateWslLinkedWorktreeGitRouting: vi.fn()
}))

import { finalizePreparedWorktree } from './worktree-create-preparation'

const originalOid = '1'.repeat(40)
const refreshedOid = '2'.repeat(40)

beforeEach(() => {
  gitExec.mockReset().mockImplementation(async (args: string[]) => ({
    stdout:
      args[0] === 'rev-parse'
        ? args.includes('--quiet') || args.at(-1) === 'HEAD'
          ? originalOid
          : refreshedOid
        : ''
  }))
})

it('reuses the current base-resolution oid and preserves WSL routing', async () => {
  await finalizePreparedWorktree('/repo', '/prepared', '/final', 'feature', 'main', false, {
    wslDistro: 'Ubuntu',
    timeout: 8000
  })
  const revisions = gitExec.mock.calls.filter(([args]) => args[0] === 'rev-parse')
  expect(revisions.map(([args]) => args)).toEqual([
    ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
    ['rev-parse', '--verify', 'HEAD']
  ])
  expect(gitExec.mock.calls.find(([args]) => args.includes('checkout'))?.[0]).toContain(originalOid)
  expect(gitExec.mock.calls.some(([args]) => args.includes('reset'))).toBe(false)
  for (const [, options] of gitExec.mock.calls) {
    expect(options).toMatchObject({ wslDistro: 'Ubuntu', timeout: 8000 })
  }
})

it.each([
  { base: 'refs/heads/main', refresh: false, options: {} },
  { base: 'main', refresh: true, options: {} },
  { base: 'main', refresh: false, options: { suggestLocalBaseRefUpdate: true } }
])('re-reads the target for $base, refresh=$refresh, options=$options', async (test) => {
  await finalizePreparedWorktree(
    '/repo',
    '/prepared',
    '/final',
    'feature',
    test.base,
    test.refresh,
    test.options
  )
  expect(gitExec).toHaveBeenCalledWith(
    ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
    expect.objectContaining({ cwd: '/repo' })
  )
  expect(gitExec.mock.calls.find(([args]) => args.includes('reset'))?.[0]).toContain(refreshedOid)
  expect(gitExec.mock.calls.find(([args]) => args.includes('checkout'))?.[0]).toContain(
    refreshedOid
  )
})

it('starts both independent probes before either resolves and settles them before failure', async () => {
  let resolveBase!: (value: { stdout: string }) => void
  let rejectPrepared!: (reason: Error) => void
  gitExec.mockImplementation((args: string[]) => {
    if (args.includes('--quiet')) {
      return new Promise((resolve) => (resolveBase = resolve))
    }
    if (args.at(-1) === 'HEAD') {
      return new Promise((_, reject) => (rejectPrepared = reject))
    }
    return Promise.resolve({ stdout: '' })
  })
  let settled = false
  const error = new Error('prepared HEAD unreadable')
  const result = finalizePreparedWorktree('/repo', '/prepared', '/final', 'feature', 'main')
  const checked = expect(result).rejects.toBe(error)
  void result.then(
    () => (settled = true),
    () => (settled = true)
  )
  await vi.waitFor(() => expect(gitExec).toHaveBeenCalledTimes(2))
  rejectPrepared(error)
  await Promise.resolve()
  expect(settled).toBe(false)
  resolveBase({ stdout: originalOid })
  await checked
  expect(gitExec.mock.calls.some(([args]) => args.includes('move'))).toBe(false)
})
