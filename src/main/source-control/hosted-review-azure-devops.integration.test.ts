import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
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

  it('resolves an Azure Repos PR through real git remote parsing and HTTP API calls', async () => {
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
        sendJson(res, { value: [{ state: 'succeeded' }] })
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
        getHostedReviewForBranch({ repoPath, branch: 'refs/heads/feature/azure' })
      ).resolves.toEqual({
        provider: 'azure-devops',
        number: 31,
        title: 'Azure branch',
        state: 'open',
        url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/31',
        status: 'success',
        updatedAt: '2026-05-16T00:00:00Z',
        mergeable: 'MERGEABLE',
        headSha: 'abc123'
      })

      expect(seen.map((request) => request.pathname)).toEqual([
        '/acme/Project/_apis/git/repositories/repo',
        '/acme/Project/_apis/git/repositories/repo-guid/pullRequests',
        '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/31/statuses'
      ])
      expect(seen.every((request) => request.authorization === 'Basic OmxvY2FsLXBhdA==')).toBe(true)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
