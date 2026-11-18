import { describe, expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: exec
}))
vi.mock('../../api/rate-limit', () => ({
  noteRepositoryRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: () => ({ blocked: false })
}))
vi.mock('../check/complete-pr-check-observation', () => ({
  readCompletePRCheckObservation: vi.fn(async () => undefined)
}))

import { fetchPullRequestWorkItem } from './work-item-fetch'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const allowedMergeMethods: Record<string, string[]> = { main: ['SQUASH'], 'feature/a': ['MERGE'] }

describe('fetchPullRequestWorkItem', () => {
  // Stack queue routing lives only in the sidebar, so the queue flag must not come from the stack base.
  it('offers the stack base merge methods but keeps the immediate base queue flag', async () => {
    exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            number: 42,
            title: 'Upper stack entry',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            isDraft: false,
            baseRefName: 'feature/a',
            headRefName: 'feature/b',
            headRefOid: 'b'.repeat(40)
          })
        }
      }
      if (args.includes('repos/acme/widgets/pulls/42')) {
        const body = {
          number: 42,
          state: 'open',
          base: { ref: 'feature/a', sha: 'a'.repeat(40) },
          head: { ref: 'feature/b', sha: 'b'.repeat(40) },
          stack: { number: 7, position: 2, size: 2, base: { ref: 'main', sha: 'c'.repeat(40) } }
        }
        return { stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}` }
      }
      const branch = args.find((arg) => arg.startsWith('branch='))?.slice('branch='.length) ?? ''
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'MERGE',
              mergeCommitAllowed: true,
              rebaseMergeAllowed: false,
              squashMergeAllowed: true,
              autoMergeAllowed: true,
              mergeQueue: branch === 'main' ? { id: 'queue' } : null,
              ref: {
                rules: {
                  nodes: [
                    {
                      type: 'PULL_REQUEST',
                      parameters: { allowedMergeMethods: allowedMergeMethods[branch] }
                    }
                  ]
                }
              }
            }
          }
        })
      }
    })

    const item = await fetchPullRequestWorkItem('/repo', repository, 42)

    expect(item?.mergeQueueRequired).toBe(false)
    expect(item?.mergeMethodSettings).toEqual({
      defaultMethod: 'squash',
      allowedMethods: { squash: true, merge: false, rebase: false }
    })
  })
})
