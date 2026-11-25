import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { resolveGitHubWorkItemLinkRepository } from './github-work-item-link-repository'

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn(async () => {
    throw new Error('gh is not available in this test')
  })
}))

const repoPath = mkdtempSync(join(tmpdir(), 'orca-link-repository-'))
execFileSync('git', ['init', '--quiet', repoPath])
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/app.git'], {
  cwd: repoPath
})
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

it('reads another repository only on a host the checkout uses, and only when allowed', async () => {
  const resolve = (owner: string, repo: string, host: string, allowSameHost?: boolean) =>
    resolveGitHubWorkItemLinkRepository(repoPath, { owner, repo, host }, { allowSameHost })

  await expect(resolve('team', 'app', 'github.com')).resolves.toMatchObject({
    owner: 'team',
    repo: 'app'
  })
  await expect(resolve('team', 'planning', 'github.com')).resolves.toBeNull()
  await expect(resolve('team', 'planning', 'GitHub.com', true)).resolves.toEqual({
    owner: 'team',
    repo: 'planning',
    host: 'github.com'
  })
  await expect(resolve('team', 'planning', 'github.example.test', true)).resolves.toBeNull()
  await expect(resolve('team', '..', 'github.com', true)).resolves.toBeNull()
  await expect(resolve('-team', 'planning', 'github.com', true)).resolves.toBeNull()
})
