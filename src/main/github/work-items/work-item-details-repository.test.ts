import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { getWorkItemDetails } from './work-item-details'

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn()
}))

it('only reads an addressed issue from a host configured on the checkout', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-issue-details-'))
  try {
    execFileSync('git', ['init', '--quiet', repoPath])
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/app.git'], {
      cwd: repoPath
    })

    vi.mocked(ghExecFileAsync).mockImplementation(async (args, options) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return { stdout: 'Logged in to github.example.test account team-member', stderr: '' }
      }
      if (args[0] === 'api' && args.some((arg) => arg.startsWith('repos/team/planning/'))) {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'api' &&
        args[1] === 'graphql' &&
        args.includes('owner=team') &&
        args.includes('repo=planning') &&
        args.includes('number=42')
      ) {
        const issue = {
          number: 42,
          title: 'Track next release',
          state: 'OPEN',
          url: `https://${options?.host}/team/planning/issues/42`,
          updatedAt: '2026-01-01T00:00:00Z',
          author: null,
          assignees: { nodes: [], pageInfo: { hasNextPage: false } },
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          body: 'Release checklist'
        }
        return { stdout: JSON.stringify({ data: { repository: { issue } } }), stderr: '' }
      }
      throw new Error('Unexpected gh request')
    })

    const issueDetails = (host: string) =>
      getWorkItemDetails(repoPath, 42, 'issue', undefined, {}, undefined, {
        owner: 'team',
        repo: 'planning',
        host
      })
    await expect(issueDetails('github.example.test')).resolves.toBeNull()
    await expect(issueDetails('github.com')).resolves.toMatchObject({
      item: { url: 'https://github.com/team/planning/issues/42', title: 'Track next release' },
      body: 'Release checklist'
    })
  } finally {
    rmSync(repoPath, { recursive: true, force: true })
  }
})
