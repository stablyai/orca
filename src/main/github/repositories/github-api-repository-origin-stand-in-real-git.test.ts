import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { resolveIssueGitHubApiRepositorySource } from './github-api-repository'
import { resolvePrWorkItemSource } from '../client/list/work-item-list-request'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

let directory: string | null = null

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = null
  }
})

async function createRepo(remotes: [name: string, url: (repo: string) => string][]) {
  const repo = await mkdtemp(join(tmpdir(), 'orca-origin-stand-in-'))
  directory = repo
  const git = async (args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  await git(['init', '-q'])
  await git(['init', '--bare', '-q', join(repo, 'mirror.git')])
  for (const [name, url] of remotes) {
    await git(['remote', 'add', name, url(repo)])
  }
  return repo
}

it('reads GitHub from the remote standing in for an origin that is a local path (#42102)', async () => {
  const repo = await createRepo([
    ['origin', (root) => join(root, 'mirror.git')],
    ['github', () => 'https://github.com/acme/widgets.git']
  ])
  const expected = { owner: 'acme', repo: 'widgets', host: 'github.com' }

  expect((await resolveIssueGitHubApiRepositorySource(repo, undefined)).source).toEqual(expected)
  expect((await resolvePrWorkItemSource(repo, undefined)).source).toEqual(expected)
})

installRealWorkerThreadChildProcesses()
