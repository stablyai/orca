import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { githubReferenceRepo } from '../../../shared/github/markdown/github-reference-links'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { probeRepoUpstream } from '../client/fetch/repo-slug-upstream'
import { listWorkItems } from '../client/list/list-work-items'
import { resolveGitHubWorkItemLinkRepository } from './github-work-item-link-repository'

vi.mock(import('../../git/command-runner/hosted-cli/gh-exec-file'), async (original) => ({
  ...(await original()),
  ghExecFileAsync: vi.fn()
}))

installRealWorkerThreadChildProcesses()

it('keeps both issue sources for a renamed fork and follows changes to its Git remotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-fork-issues-'))
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: dir })
  const origin = { owner: 'openaustralia', repo: 'righttoknow', host: 'github.com' }
  const parent = { owner: 'mysociety', repo: 'alavetelitheme', host: 'github.com' }
  const plain = { owner: 'other', repo: 'project', host: 'github.com' }
  vi.mocked(ghExecFileAsync).mockImplementation(async (args) => {
    if (args[0] === 'repo' && args[1] === 'view') {
      const fork = args[2] === 'github.com/openaustralia/righttoknow'
      return {
        stdout: JSON.stringify({
          isFork: fork,
          parent: fork ? { owner: { login: 'mysociety' }, name: 'alavetelitheme' } : null
        }),
        stderr: ''
      }
    }
    if (args.some((arg) => arg.startsWith('search/issues?'))) {
      return { stdout: '[]', stderr: '' }
    }
    throw new Error('Unsupported GitHub lookup')
  })
  const list = (preference?: 'upstream' | 'origin') =>
    listWorkItems(dir, 10, 'is:issue', 1, preference)

  try {
    await git('init', '-q')
    await git('remote', 'add', 'origin', 'https://github.com/openaustralia/righttoknow.git')
    const { upstream } = await probeRepoUpstream(dir)
    for (const [preference, selected] of [
      [undefined, parent],
      ['upstream', parent],
      ['origin', origin]
    ] as const) {
      const result = await list(preference)
      expect(result.issueSourceFellBack).toBeUndefined()
      expect(result.sources).toEqual({
        issues: selected,
        prs: selected,
        originCandidate: origin,
        upstreamCandidate: parent
      })
      expect(
        githubReferenceRepo(
          { upstream, issueSourcePreference: preference },
          'openaustralia/righttoknow'
        )
      ).toEqual({
        owner: selected.owner,
        repo: selected.repo
      })
    }
    expect(await resolveGitHubWorkItemLinkRepository(dir, parent, {})).toEqual(parent)
    expect(await resolveGitHubWorkItemLinkRepository(dir, plain, {})).toBeNull()

    await git('remote', 'add', 'upstream', 'https://github.com/other/project.git')
    expect((await list()).sources.upstreamCandidate).toEqual(plain)
    await git('remote', 'remove', 'upstream')
    await git('remote', 'set-url', 'origin', 'https://github.com/other/project.git')
    expect(await list('upstream')).toMatchObject({
      sources: { issues: plain, upstreamCandidate: null },
      issueSourceFellBack: true
    })
  } finally {
    await removeTree(dir)
  }
})
