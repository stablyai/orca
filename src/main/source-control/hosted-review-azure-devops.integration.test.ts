import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetAzureDevOpsRepoRefCache } from '../azure-devops/repository-ref'
import { getHostedReviewForBranch } from './hosted-review'

const execFileAsync = promisify(execFile)
const OLD_ENV = process.env

type SeenRequest = {
  pathname: string
  search: string
  authorization: string | undefined
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('Azure DevOps hosted review integration', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'local-pat' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    _resetAzureDevOpsRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    _resetAzureDevOpsRepoRefCache()
  })

  it.each(['canceled', 'cancelled', 'failed'])(
    'preserves %s through Azure lookup and hosted review mapping',
    async (state) => {
      const seen: SeenRequest[] = []
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        seen.push({
          pathname: url.pathname,
          search: url.search,
          authorization: req.headers.authorization
        })

        if (url.pathname === '/acme/Project/_apis/git/repositories/repo') {
          sendJson(res, {
            id: 'repo-guid',
            webUrl: 'https://dev.azure.com/acme/Project/_git/repo'
          })
          return
        }

        if (url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests') {
          expect(url.searchParams.get('searchCriteria.sourceRefName')).toBe(
            'refs/heads/feature/azure'
          )
          sendJson(res, {
            value: [
              {
                pullRequestId: 31,
                title: 'Azure branch',
                status: 'active',
                creationDate: '2026-05-16T00:00:00Z',
                mergeStatus: 'succeeded',
                lastMergeSourceCommit: { commitId: 'abc123' }
              }
            ]
          })
          return
        }

        if (
          url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/31/statuses'
        ) {
          sendJson(res, {
            value: [
              { state: 'succeeded' },
              ...(state === 'failed' ? [{ state: 'cancelled' }] : []),
              { state }
            ]
          })
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'not found' }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

      const repoPath = await mkdtemp(join(tmpdir(), 'orca-azure-review-'))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('expected TCP server address')
        }
        process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = `http://127.0.0.1:${address.port}/acme/Project`

        await execFileAsync('git', ['init'], { cwd: repoPath })
        await execFileAsync(
          'git',
          ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Project/_git/repo'],
          { cwd: repoPath }
        )

        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feature/azure'
          })
        ).resolves.toEqual({
          provider: 'azure-devops',
          number: 31,
          title: 'Azure branch',
          state: 'open',
          url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/31',
          status: 'failure',
          checksSummary: {
            state: 'failure',
            total: state === 'failed' ? 3 : 2,
            passed: 1,
            failed: state === 'failed' ? 2 : 1,
            cancelled: 1,
            pending: 0,
            neutral: 0
          },
          updatedAt: '2026-05-16T00:00:00Z',
          mergeable: 'MERGEABLE',
          headSha: 'abc123'
        })

        expect(seen.map((request) => request.pathname)).toEqual([
          '/acme/Project/_apis/git/repositories/repo',
          '/acme/Project/_apis/git/repositories/repo-guid/pullRequests',
          '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/31/statuses'
        ])
        expect(seen.every((request) => request.authorization === 'Basic OmxvY2FsLXBhdA==')).toBe(
          true
        )
      } finally {
        await rm(repoPath, { recursive: true, force: true })
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  )

  async function createReusedBranchRepo(): Promise<string> {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-azure-review-'))
    await execFileAsync('git', ['init', '-b', 'feature/azure'], { cwd: repoPath })
    await execFileAsync('git', ['config', 'user.email', 'dev@example.com'], { cwd: repoPath })
    await execFileAsync('git', ['config', 'user.name', 'Dev'], { cwd: repoPath })
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'reuse branch'], {
      cwd: repoPath
    })
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Project/_git/repo'],
      { cwd: repoPath }
    )
    return repoPath
  }

  function serveBranchPullRequests(
    value: unknown[],
    seen?: string[]
  ): ReturnType<typeof createServer> {
    return createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      seen?.push(url.pathname)

      if (url.pathname === '/acme/Project/_apis/git/repositories/repo') {
        sendJson(res, {
          id: 'repo-guid',
          webUrl: 'https://dev.azure.com/acme/Project/_git/repo'
        })
        return
      }
      if (url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests') {
        sendJson(res, { value })
        return
      }
      const statuses = url.pathname.match(
        /\/acme\/Project\/_apis\/git\/repositories\/repo-guid\/pullRequests\/(\d+)\/statuses$/
      )
      if (statuses) {
        sendJson(res, { value: [{ state: 'succeeded' }] })
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'not found' }))
    })
  }

  function completedPullRequest(number: number, commitId: string) {
    return {
      pullRequestId: number,
      title: 'Completed branch review',
      status: 'completed',
      creationDate: '2026-10-29T00:00:00Z',
      closedDate: '2026-11-02T00:00:00Z',
      mergeStatus: 'succeeded',
      lastMergeSourceCommit: { commitId }
    }
  }

  async function withAzureServerAndRepo(
    value: unknown[],
    run: (repoPath: string) => Promise<void>
  ): Promise<void> {
    const server = serveBranchPullRequests(value)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const repoPath = await createReusedBranchRepo()
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address')
      }
      process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = `http://127.0.0.1:${address.port}/acme/Project`
      await run(repoPath)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }

  it('hides a completed PR whose last source commit no longer matches the reused branch head', async () => {
    const seen: string[] = []
    const server = serveBranchPullRequests(
      [completedPullRequest(77, '1111111111111111111111111111111111111111')],
      seen
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const repoPath = await createReusedBranchRepo()
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address')
      }
      process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = `http://127.0.0.1:${address.port}/acme/Project`

      await expect(
        getHostedReviewForBranch({
          executionHostId: 'local',
          repoPath,
          branch: 'refs/heads/feature/azure'
        })
      ).resolves.toBeNull()
      // Hiding happens before status lookups, so a stale merged match never fetches them.
      expect(seen.some((pathname) => pathname.endsWith('/statuses'))).toBe(false)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('keeps a completed PR whose last source commit still matches the branch head', async () => {
    const repoPath = await createReusedBranchRepo()
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath })
    const headSha = stdout.trim()
    const server = serveBranchPullRequests([completedPullRequest(77, headSha)])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address')
      }
      process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = `http://127.0.0.1:${address.port}/acme/Project`

      await expect(
        getHostedReviewForBranch({
          executionHostId: 'local',
          repoPath,
          branch: 'refs/heads/feature/azure'
        })
      ).resolves.toMatchObject({
        provider: 'azure-devops',
        number: 77,
        state: 'merged',
        headSha
      })
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('keeps an explicitly linked completed PR visible when the branch head moved on', async () => {
    await withAzureServerAndRepo(
      [completedPullRequest(77, '1111111111111111111111111111111111111111')],
      async (repoPath) => {
        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feature/azure',
            linkedAzureDevOpsPR: 77
          })
        ).resolves.toMatchObject({ provider: 'azure-devops', number: 77, state: 'merged' })
      }
    )
  })

  it('does not let a stale completed PR shadow the explicitly linked PR', async () => {
    await withAzureServerAndRepo(
      [
        completedPullRequest(78, '1111111111111111111111111111111111111111'),
        {
          pullRequestId: 79,
          title: 'Linked branch review',
          status: 'active',
          creationDate: '2026-10-30T00:00:00Z',
          mergeStatus: 'succeeded',
          lastMergeSourceCommit: { commitId: '2222222222222222222222222222222222222222' }
        }
      ],
      async (repoPath) => {
        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feature/azure',
            linkedAzureDevOpsPR: 79
          })
        ).resolves.toMatchObject({ provider: 'azure-devops', number: 79, state: 'open' })
      }
    )
  })

  it('does not let a stale completed PR shadow a linked completed PR', async () => {
    await withAzureServerAndRepo(
      [
        completedPullRequest(78, '1111111111111111111111111111111111111111'),
        {
          pullRequestId: 79,
          title: 'Linked completed branch review',
          status: 'completed',
          creationDate: '2026-10-29T00:00:00Z',
          closedDate: '2026-11-01T00:00:00Z',
          mergeStatus: 'succeeded',
          lastMergeSourceCommit: { commitId: '2222222222222222222222222222222222222222' }
        }
      ],
      async (repoPath) => {
        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feature/azure',
            linkedAzureDevOpsPR: 79
          })
        ).resolves.toMatchObject({ provider: 'azure-devops', number: 79, state: 'merged' })
      }
    )
  })

  it('surfaces the active PR hidden behind a newer completed one on a reused branch', async () => {
    await withAzureServerAndRepo(
      [
        completedPullRequest(78, '1111111111111111111111111111111111111111'),
        {
          pullRequestId: 79,
          title: 'Active branch review',
          status: 'active',
          creationDate: '2026-10-30T00:00:00Z',
          mergeStatus: 'succeeded',
          lastMergeSourceCommit: { commitId: '2222222222222222222222222222222222222222' }
        }
      ],
      async (repoPath) => {
        await expect(
          getHostedReviewForBranch({
            executionHostId: 'local',
            repoPath,
            branch: 'refs/heads/feature/azure'
          })
        ).resolves.toMatchObject({ provider: 'azure-devops', number: 79, state: 'open' })
      }
    )
  })
})
