import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetBitbucketServerRepoRefCache } from '../bitbucket/server-repository-ref'
import { _resetBitbucketRepoRefCache } from '../bitbucket/repository-ref'
import { _resetGiteaRepoRefCache } from '../gitea/repository-ref'
import { detectHostedReviewProvider } from './forge-provider'
import { getHostedReviewForBranch } from './hosted-review'
import { __resetHostedReviewBranchCacheForTests } from './hosted-review-branch-cache'

const execFileAsync = promisify(execFile)
const OLD_ENV = process.env

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function withServerAndRepo(
  handler: (url: URL, res: ServerResponse) => void,
  run: (origin: string, repoPath: string) => Promise<void>
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handler(new URL(req.url ?? '/', 'http://127.0.0.1'), res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const repoPath = await mkdtemp(join(tmpdir(), 'orca-bitbucket-server-review-'))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP server address')
    }
    const origin = `http://127.0.0.1:${address.port}`
    await execFileAsync('git', ['init'], { cwd: repoPath })
    await execFileAsync('git', ['remote', 'add', 'origin', `${origin}/scm/prj/repo.git`], {
      cwd: repoPath
    })
    await run(origin, repoPath)
  } finally {
    await rm(repoPath, { recursive: true, force: true })
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function resetCaches(): void {
  _resetBitbucketServerRepoRefCache()
  _resetBitbucketRepoRefCache()
  _resetGiteaRepoRefCache()
  __resetHostedReviewBranchCacheForTests()
}

describe('Bitbucket Server hosted review integration', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_BITBUCKET_SERVER_TOKEN: 'server-token' }
    delete process.env.ORCA_BITBUCKET_SERVER_BASE_URL
    resetCaches()
  })

  afterEach(() => {
    process.env = OLD_ENV
    resetCaches()
  })

  it('resolves a PR through real git remote parsing and the server REST API', async () => {
    const seen: string[] = []
    await withServerAndRepo(
      (url, res) => {
        seen.push(url.pathname)
        if (url.pathname === '/rest/api/1.0/projects/prj/repos/repo/pull-requests') {
          sendJson(res, {
            size: 1,
            values: [
              {
                id: 12,
                title: 'Local server branch',
                state: 'OPEN',
                updatedDate: 1792460776769,
                fromRef: { id: 'refs/heads/feat', displayId: 'feat', latestCommit: 'abc123' },
                toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'def456' },
                reviewers: [{ user: { name: 'bob' }, status: 'APPROVED' }],
                links: { self: [{ href: 'https://bitbucket.example.com/pr/12' }] }
              }
            ]
          })
          return
        }
        if (url.pathname === '/rest/api/1.0/projects/prj/repos/repo/pull-requests/12/merge') {
          sendJson(res, { canMerge: true, conflicted: false, outcome: 'CLEAN', vetoes: [] })
          return
        }
        if (url.pathname === '/rest/build-status/1.0/commits/stats/abc123') {
          sendJson(res, { successful: 1, inProgress: 0, failed: 0 })
          return
        }
        res.writeHead(404)
        res.end()
      },
      async (origin, repoPath) => {
        process.env.ORCA_BITBUCKET_SERVER_BASE_URL = origin

        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feat'
          })
        ).resolves.toEqual({
          provider: 'bitbucket',
          number: 12,
          title: 'Local server branch',
          state: 'open',
          url: 'https://bitbucket.example.com/pr/12',
          status: 'success',
          updatedAt: new Date(1792460776769).toISOString(),
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          headSha: 'abc123'
        })
        expect(seen.toSorted()).toEqual([
          '/rest/api/1.0/projects/prj/repos/repo/pull-requests',
          '/rest/api/1.0/projects/prj/repos/repo/pull-requests/12/merge',
          '/rest/build-status/1.0/commits/stats/abc123'
        ])
      }
    )
  })

  it('leaves provider detection unchanged when no server is registered', async () => {
    await withServerAndRepo(
      (_url, res) => {
        res.writeHead(404)
        res.end()
      },
      async (origin, repoPath) => {
        // Why: pins today's behavior — an unregistered self-hosted remote is not claimed by bitbucket.
        await expect(
          detectHostedReviewProvider({ executionHostId: 'local', repoPath })
        ).resolves.not.toBe('bitbucket')

        resetCaches()
        process.env.ORCA_BITBUCKET_SERVER_BASE_URL = origin
        await expect(
          detectHostedReviewProvider({ executionHostId: 'local', repoPath })
        ).resolves.toBe('bitbucket')
      }
    )
  })
})
