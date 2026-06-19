import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetGiteaRepoRefCache } from '../gitea/repository-ref'
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

describe('Gitea hosted review integration', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_GITEA_TOKEN: 'local-token' }
    delete process.env.ORCA_GITEA_API_BASE_URL
    _resetGiteaRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    _resetGiteaRepoRefCache()
  })

  it('resolves a Gitea PR through real git remote parsing and HTTP API calls', async () => {
    const seen: SeenRequest[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      seen.push({
        pathname: url.pathname,
        search: url.search,
        authorization: req.headers.authorization
      })

      if (url.pathname === '/api/v1/repos/team/repo/pulls') {
        sendJson(res, [
          {
            number: 9,
            title: 'Local Gitea branch',
            state: 'open',
            html_url: 'http://127.0.0.1/team/repo/pulls/9',
            updated_at: '2026-05-15T00:00:00Z',
            mergeable: true,
            head: { ref: 'feature/gitea', label: 'team:feature/gitea', sha: 'abc123' }
          }
        ])
        return
      }

      if (url.pathname === '/api/v1/repos/team/repo/commits/abc123/status') {
        sendJson(res, { state: 'success' })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'not found' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gitea-review-'))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address')
      }

      await execFileAsync('git', ['init'], { cwd: repoPath })
      await execFileAsync(
        'git',
        ['remote', 'add', 'origin', `http://127.0.0.1:${address.port}/team/repo.git`],
        { cwd: repoPath }
      )

      await expect(
        getHostedReviewForBranch({ repoPath, branch: 'refs/heads/feature/gitea' })
      ).resolves.toEqual({
        provider: 'gitea',
        number: 9,
        title: 'Local Gitea branch',
        state: 'open',
        url: 'http://127.0.0.1/team/repo/pulls/9',
        status: 'success',
        updatedAt: '2026-05-15T00:00:00Z',
        mergeable: 'MERGEABLE',
        headSha: 'abc123'
      })

      expect(seen.map((request) => request.pathname)).toEqual([
        '/api/v1/repos/team/repo/pulls',
        '/api/v1/repos/team/repo/commits/abc123/status'
      ])
      expect(seen.every((request) => request.authorization === 'token local-token')).toBe(true)
      expect(new URLSearchParams(seen[0].search).get('state')).toBe('all')
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
