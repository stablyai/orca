/**
 * Local repos coalesce concurrent `git worktree list` scans (`shareWorktreeScan`); the SSH path
 * branched away from that and paid one relay round trip per independent caller (`worktrees:list`,
 * `worktrees:listAll`, the space repo scan, provisioned-root adoption). These are call counters.
 */
import { describe, expect, it } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'

const REPO_PATH = '/home/user/repo'

const WORKTREES = [
  { path: REPO_PATH, head: 'abc123', branch: 'main', isBare: false, isMainWorktree: true }
]

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** Holds `git.listWorktrees` open so overlap is deterministic; answers everything else at once. */
function createPendingListMux(): { mux: MockMultiplexer; listDeferreds: Deferred[] } {
  const mux = createMockMux()
  const listDeferreds: Deferred[] = []
  mux.request.mockImplementation((method: string) => {
    if (method !== 'git.listWorktrees') {
      return Promise.resolve(undefined)
    }
    return new Promise((resolve, reject) => {
      listDeferreds.push({ resolve, reject })
    })
  })
  return { mux, listDeferreds }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function countListRequests(mux: MockMultiplexer): number {
  return mux.request.mock.calls.filter((call) => call[0] === 'git.listWorktrees').length
}

describe('SSH git.listWorktrees in-flight dedupe', () => {
  it('collapses concurrent listings of one repo into a single relay request', async () => {
    const { mux, listDeferreds } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    const listings = Array.from({ length: 6 }, () => provider.listWorktrees(REPO_PATH))
    await flush()

    expect(countListRequests(mux)).toBe(1)
    expect(mux.request).toHaveBeenCalledWith(
      'git.listWorktrees',
      { repoPath: REPO_PATH },
      { signal: undefined }
    )

    listDeferreds[0].resolve(WORKTREES)
    expect(await Promise.all(listings)).toEqual(Array.from({ length: 6 }, () => WORKTREES))
  })

  it('does not share across repos or connections', async () => {
    const { mux } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    void provider.listWorktrees(REPO_PATH)
    void provider.listWorktrees('/home/user/other')
    await flush()
    expect(countListRequests(mux)).toBe(2)

    const second = createPendingListMux()
    void new SshGitProvider('conn-2', second.mux as never).listWorktrees(REPO_PATH)
    await flush()

    expect(countListRequests(second.mux)).toBe(1)
    expect(countListRequests(mux)).toBe(2)
  })

  it('keeps a signalled listing on its own request', async () => {
    const { mux } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    void provider.listWorktrees(REPO_PATH)
    await flush()
    const controller = new AbortController()
    void provider.listWorktrees(REPO_PATH, { signal: controller.signal })
    await flush()

    expect(countListRequests(mux)).toBe(2)
    expect(mux.request).toHaveBeenCalledWith(
      'git.listWorktrees',
      { repoPath: REPO_PATH },
      { signal: controller.signal }
    )
  })

  it('re-requests after the shared listing settles instead of caching it', async () => {
    const { mux, listDeferreds } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    const first = provider.listWorktrees(REPO_PATH)
    await flush()
    listDeferreds[0].resolve(WORKTREES)
    await first

    void provider.listWorktrees(REPO_PATH)
    await flush()

    expect(countListRequests(mux)).toBe(2)
  })

  it.each([
    ['addWorktree', (p: SshGitProvider) => p.addWorktree(REPO_PATH, 'feature', '/home/user/feat')],
    ['removeWorktree', (p: SshGitProvider) => p.removeWorktree('/home/user/feat')]
  ])('invalidates the shared listing after %s', async (_name, mutate) => {
    const { mux } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    void provider.listWorktrees(REPO_PATH)
    await flush()
    expect(countListRequests(mux)).toBe(1)

    await mutate(provider)

    // The catalog moved, so a joiner must not inherit the pre-mutation scan.
    void provider.listWorktrees(REPO_PATH)
    await flush()
    expect(countListRequests(mux)).toBe(2)
  })

  it('shares a failed listing with its joiners and re-requests afterwards', async () => {
    const { mux, listDeferreds } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    const listings = [provider.listWorktrees(REPO_PATH), provider.listWorktrees(REPO_PATH)]
    await flush()
    expect(countListRequests(mux)).toBe(1)

    const failure = new Error('relay request failed')
    listDeferreds[0].reject(failure)
    await expect(listings[0]).rejects.toBe(failure)
    await expect(listings[1]).rejects.toBe(failure)

    void provider.listWorktrees(REPO_PATH)
    await flush()
    expect(countListRequests(mux)).toBe(2)
  })

  it('refuses an unauthoritative relay answer for every joiner (#14004)', async () => {
    const { mux, listDeferreds } = createPendingListMux()
    const provider = new SshGitProvider('conn-1', mux as never)

    const listings = [provider.listWorktrees(REPO_PATH), provider.listWorktrees(REPO_PATH)]
    await flush()
    listDeferreds[0].resolve([])

    await expect(listings[0]).rejects.toThrow()
    await expect(listings[1]).rejects.toThrow()
  })
})
