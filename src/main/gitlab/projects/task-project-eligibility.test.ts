import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as FileSystem from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) }
})

const { git, glab, gh } = vi.hoisted(() => ({ git: vi.fn(), glab: vi.fn(), gh: vi.fn() }))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: git
}))

vi.mock('../../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glab
}))

vi.mock('../../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: gh
}))

import { listMergeRequests } from '../merge-requests/merge-request-list'
import { isTaskRepositoryIneligible } from '../../git/task-repository-eligibility'
import { rememberGlabKnownHosts } from './gitlab-known-host-probe'
import '../issues/gitlab-issue-queries'
import { _resetProjectRefCache } from './gitlab-project-ref-resolution'
import { _resetKnownHostsCache } from './gitlab-known-host-probe'
import { _resetRemoteNameListingCache } from '../../git/remotes/remote-name-listing'

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

  it('does not exclude GitHub tasks because glab remembers github.com', async () => {
    rememberGlabKnownHosts(['github.com'])
    await expect(isTaskRepositoryIneligible('/github', 'github')).resolves.toBe(false)
  })
})
