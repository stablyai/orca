import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type * as FileSystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) }
})

const { git, glab, gh } = vi.hoisted(() => ({ git: vi.fn(), glab: vi.fn(), gh: vi.fn() }))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: git,
  glabExecFileAsync: glab,
  ghExecFileAsync: gh
}))

import { listMergeRequests } from './merge-request-list'
import { listIssues } from './issues'
import { _resetProjectRefCache, _resetKnownHostsCache } from './gitlab-project-ref-resolution'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'
import { resolveIssueSource } from './gitlab-issue-source-resolution'

function serveRemotes(repos: Record<string, Record<string, string>>): void {
  git.mockImplementation(async (args: string[], options: { cwd: string }) => {
    const remotes = repos[options.cwd] ?? {}
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: Object.keys(remotes).join('\n') }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return {
        stdout: Object.entries(remotes)
          .map(([name, url]) => `${name}\t${url} (fetch)`)
          .join('\n')
      }
    }
    if (args[0] === 'remote' && args[1] === 'get-url' && remotes[args[2]]) {
      return { stdout: remotes[args[2]] }
    }
    throw new Error(`No such remote: ${args.join(' ')}`)
  })
}

describe('GitLab task project admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetProjectRefCache()
    _resetKnownHostsCache()
    _resetRemoteNameListingCache()
    gh.mockResolvedValue({ stdout: '' })
    serveRemotes({
      '/gitlab': { origin: 'git@gitlab.com:team/project.git' },
      '/github': { origin: 'git@github.com:team/project.git' }
    })
    glab.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth') {
        if (args.includes('github.com')) {
          throw new Error('No GitLab account for github.com')
        }
        return { stdout: 'gitlab.com\n  ✓ Logged in to gitlab.com\n' }
      }
      if (args[0] === 'api') {
        return { stdout: 'HTTP/2.0 200 OK\r\nX-Total: 0\r\nX-Total-Pages: 1\r\n\r\n[]' }
      }
      throw new Error('None of the git remotes correspond to the GITLAB_HOST environment variable')
    })
  })

  it.each(['mrs', 'issues'] as const)(
    'keeps an eligible empty %s list clean when the shared selection also contains GitHub',
    async (view) => {
      const list = view === 'mrs' ? listMergeRequests : listIssues
      const results = await Promise.all(['/gitlab', '/github'].map((repo) => list(repo)))
      for (const result of results) {
        expect(result.items).toEqual([])
        expect(result.error).toBeUndefined()
      }
      const listCalls = glab.mock.calls.filter(([args]) => args[0] !== 'auth')
      expect(listCalls).toHaveLength(1)
      expect(listCalls[0][0][0]).toBe('api')
      expect(listCalls[0][1]).toMatchObject({ cwd: '/gitlab' })
    }
  )

  it.each(['upstream', 'gitlab'])(
    'keeps a matching %s remote when origin is hosted on another forge',
    async (remoteName) => {
      serveRemotes({
        '/mixed': {
          origin: 'git@github.com:team/fork.git',
          [remoteName]: 'git@gitlab.com:group/project.git'
        }
      })

      const result = await listMergeRequests('/mixed')

      expect(result.error).toBeUndefined()
      expect(glab).toHaveBeenCalledWith(
        ['api', '-i', expect.stringContaining('projects/group%2Fproject/merge_requests?')],
        { cwd: '/mixed' }
      )
    }
  )

  it('never queries the old GitLab project after a warm WSL remote migrates to GitHub', async () => {
    serveRemotes({ '/migrating': { origin: 'git@gitlab.com:team/project.git' } })
    const options = { wslDistro: 'Ubuntu' }
    await listMergeRequests('/migrating', 'opened', 1, 20, undefined, undefined, null, options)
    glab.mockClear()
    serveRemotes({ '/migrating': { origin: 'git@github.com:team/project.git' } })

    const result = await listMergeRequests(
      '/migrating',
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      options
    )

    expect(result.error).toBeUndefined()
    expect(result.items).toEqual([])
    expect(glab.mock.calls.filter(([args]) => args[0] !== 'auth')).toEqual([])
  })

  it.each([1, 3, 30])('bounds actual config traversal cold/warm at %i remotes', async (count) => {
    const repo = await mkdtemp(join(tmpdir(), 'gitlab-signature-'))
    try {
      const remotes = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          i ? `fork-${i}` : 'origin',
          `https://${count === 1 ? 'gitlab' : 'github'}.com/team/p${i}.git`
        ])
      )
      const config = Object.entries(remotes)
        .map(([name, url]) => `[remote "${name}"]\nurl=${url}\n`)
        .join('')
      await mkdir(join(repo, '.git'))
      await writeFile(join(repo, '.git/config'), config)
      serveRemotes({ [repo]: remotes })
      for (const warm of [false, true]) {
        vi.mocked(readFile).mockClear()
        vi.mocked(stat).mockClear()
        git.mockClear()
        glab.mockClear()
        const { source } = await resolveIssueSource(repo, 'auto')
        expect(source?.path ?? null).toBe(count === 1 ? 'team/p0' : null)
        // Identity shares the initial observation; unchanged name discovery adds constant traversals.
        const traversals = count === 1 ? (warm ? 1 : 2) : warm ? 2 : 3
        const reads = vi
          .mocked(readFile)
          .mock.calls.filter(([path]) => path === join(repo, '.git/config')).length
        expect([
          reads,
          vi.mocked(readFile).mock.calls.length,
          vi.mocked(stat).mock.calls.length
        ]).toEqual([traversals, traversals * 2, traversals * 3])
        const contents = await Promise.all(
          vi
            .mocked(readFile)
            .mock.results.map(({ value }) => Promise.resolve(value).catch(() => ''))
        )
        const bytes = contents.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
        expect(bytes).toBe(traversals * Buffer.byteLength(config))
        expect(git.mock.calls.filter(([args]) => args[1] === 'get-url')).toHaveLength(
          warm ? 0 : count
        )
        expect(git.mock.calls.filter(([args]) => args.length === 1)).toHaveLength(warm ? 0 : 1)
        expect(glab).toHaveBeenCalledTimes(count === 1 || warm ? 0 : 1)
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
