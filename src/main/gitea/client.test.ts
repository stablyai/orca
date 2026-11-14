import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
import { getGiteaPullRequestForBranch, getGiteaPullRequestForBranchOrThrow } from './client'
import { _resetGiteaRepoRefCache } from './repository-ref'
import {
  _getGiteaPullRequestScanCacheSize,
  _resetGiteaPullRequestScanCache
} from './pull-request-scan-cache'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const OLD_ENV = process.env

function primeGitExecWithDefaultBranch(defaultRef = 'refs/remotes/origin/main'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: 'https://git.example.com/team/repo.git\n', stderr: '' }
    }
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      return { stdout: `refs/remotes/origin/HEAD\0${defaultRef}\n`, stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

function giteaPr(index = 7, branch = 'feature/gitea') {
  return {
    number: index,
    title: 'Add Gitea',
    state: 'open',
    html_url: `https://git.example.com/team/repo/pulls/${index}`,
    updated_at: '2026-05-15T00:00:00Z',
    mergeable: true,
    head: {
      ref: branch,
      label: `team:${branch}`,
      sha: 'abc123'
    }
  }
}

describe('Gitea client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    delete process.env.ORCA_GITEA_API_BASE_URL
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/team/repo.git\n',
      stderr: ''
    })
    _resetGiteaRepoRefCache()
    _resetGiteaPullRequestScanCache()
    __resetRepoDefaultBranchCacheForTests()
    vi.unstubAllGlobals()
  })

  it('discards a closed default-branch shadow and refetches the linked PR via the fallback (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (parsed.pathname.endsWith('/pulls/42')) {
        return Response.json(giteaPr(42, 'main'))
      }
      return Response.json([{ ...giteaPr(7, 'main'), state: 'closed' }])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranch('/repo', 'refs/heads/main', 42)
    ).resolves.toMatchObject({ number: 42 })
  })

  it('surfaces a lookup failure via getGiteaPullRequestForBranchOrThrow instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'unauthorized' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
    // Strict lookup must distinguish unavailable transport from a confirmed missing review.
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed/
    )
  })

  it('treats a 404 on the linked PR as "no PR" rather than a lookup failure', async () => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      requested.push(new URL(String(url)).pathname)
      // The branch scan succeeds and is simply empty; only PR #42 is gone.
      return String(url).includes('/pulls/42')
        ? Response.json({ message: 'not found' }, { status: 404 })
        : Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea', 42)
    ).resolves.toBeNull()
    expect(requested).toEqual(['/api/v1/repos/team/repo/pulls', '/api/v1/repos/team/repo/pulls/42'])
  })

  it('still throws on a 404 from the /pulls scan so a misconfigured host is not read as "no PR"', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'not found' }, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    // A repo-level 404 means wrong base URL / repo absent / token lacks scope —
    // collapsing it to "no PR" would hide the misconfiguration indefinitely.
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed: HTTP 404/
    )
  })

  it('does not let an in-flight scan re-cache results from before an invalidation', async () => {
    let releaseFirstScan!: () => void
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      if (listCalls === 1) {
        // First scan is in flight (pre-create listing) when the invalidation lands.
        await firstScanGate
        return Response.json([giteaPr(7, 'feature/old')])
      }
      return Response.json([giteaPr(7, 'feature/old'), giteaPr(8, 'feature/new')])
    })
    vi.stubGlobal('fetch', fetchMock)

    const staleScanRead = getGiteaPullRequestForBranch('/repo', 'feature/old')
    const { invalidateGiteaPullRequestScanForRepo, getGiteaRepoSlug } = await import('./client')
    const repo = await getGiteaRepoSlug('/repo')
    invalidateGiteaPullRequestScanForRepo(repo!)
    releaseFirstScan()
    await staleScanRead

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/new')).resolves.toMatchObject({
      number: 8
    })
    expect(listCalls).toBe(2)
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    const fetchMock = vi.fn(async () =>
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'refs/heads/feature/gitea')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })
})
