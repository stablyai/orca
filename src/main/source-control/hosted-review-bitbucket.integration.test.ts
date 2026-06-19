import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetBitbucketRepoRefCache } from '../bitbucket/repository-ref'
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

describe('Bitbucket hosted review integration', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_BITBUCKET_ACCESS_TOKEN: 'local-token' }
    delete process.env.ORCA_BITBUCKET_EMAIL
    delete process.env.ORCA_BITBUCKET_API_TOKEN
    _resetBitbucketRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    _resetBitbucketRepoRefCache()
  })

  it('resolves a Bitbucket PR through real git remote parsing and HTTP API calls', async () => {
    const seen: SeenRequest[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      seen.push({
        pathname: url.pathname,
        search: url.search,
        authorization: req.headers.authorization
      })

      if (url.pathname === '/2.0/repositories/team/repo/pullrequests') {
        sendJson(res, {
          values: [
            {
              id: 12,
              title: 'Local Bitbucket branch',
              state: 'OPEN',
              updated_on: '2026-05-15T00:00:00Z',
              links: {
                html: { href: 'https://bitbucket.org/team/repo/pull-requests/12' }
              },
              source: {
                branch: { name: 'feature/bitbucket' },
                commit: { hash: 'abc123' }
              }
            }
          ]
        })
        return
      }

      if (url.pathname === '/2.0/repositories/team/repo/commit/abc123/statuses/build') {
        sendJson(res, { values: [{ state: 'SUCCESSFUL' }] })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'not found' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const repoPath = await mkdtemp(join(tmpdir(), 'orca-bitbucket-review-'))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address')
      }

      process.env.ORCA_BITBUCKET_API_BASE_URL = `http://127.0.0.1:${address.port}/2.0`
      await execFileAsync('git', ['init'], { cwd: repoPath })
      await execFileAsync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:team/repo.git'], {
        cwd: repoPath
      })

      await expect(
        getHostedReviewForBranch({ repoPath, branch: 'refs/heads/feature/bitbucket' })
      ).resolves.toEqual({
        provider: 'bitbucket',
        number: 12,
        title: 'Local Bitbucket branch',
        state: 'open',
        url: 'https://bitbucket.org/team/repo/pull-requests/12',
        status: 'success',
        updatedAt: '2026-05-15T00:00:00Z',
        mergeable: 'UNKNOWN',
        headSha: 'abc123'
      })

      expect(seen.map((request) => request.pathname)).toEqual([
        '/2.0/repositories/team/repo/pullrequests',
        '/2.0/repositories/team/repo/commit/abc123/statuses/build'
      ])
      expect(seen.every((request) => request.authorization === 'Bearer local-token')).toBe(true)
      const query = new URLSearchParams(seen[0].search)
      expect(query.get('q')).toContain('source.branch.name = "feature/bitbucket"')
      expect(query.getAll('state')).toEqual(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
