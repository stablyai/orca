import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  glabExecFileAsyncMock,
  getGlabKnownHostsMock,
  resolveIssueSourceMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  glabRepoExecOptionsMock: vi.fn(
    (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions: { wslDistro?: string } = {}
    ) => (connectionId ? {} : { cwd: repoPath, ...localGitOptions })
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  getGlabKnownHosts: getGlabKnownHostsMock,
  resolveIssueSource: resolveIssueSourceMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: glabRepoExecOptionsMock
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    resolveIssueSourceMock.mockReset()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  it('caps MR detail discussions, jobs, and file diffs to one API page', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'Bound detail payloads',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'feature/bounds',
            target_branch: 'main',
            description: 'MR body',
            sha: 'head-sha',
            diff_refs: { base_sha: 'base-sha', start_sha: 'start-sha' },
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 'discussion-1',
              notes: [
                {
                  id: 1,
                  body: 'Review note',
                  created_at: '2026-05-31T12:01:00Z',
                  author: { username: 'alice', avatar_url: 'https://example.com/a.png' }
                }
              ]
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'verify',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-old\n+new'
            }
          ])
        }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')

    expect(details?.comments).toHaveLength(1)
    expect(details?.pipelineJobs).toHaveLength(1)
    expect(details?.files).toHaveLength(1)
    expect(details?.files?.[0]).toMatchObject({
      path: 'src/app.ts',
      additions: 1,
      deletions: 1
    })
    expect(glabExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'api',
      'projects/g%2Fp/merge_requests/12/diffs?per_page=100'
    ])
    expect(glabExecFileAsyncMock.mock.calls.flatMap(([args]) => args)).not.toContain('--paginate')
  })

  it('routes local WSL MR detail fetches through project resolution and glab options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'WSL detail',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-06-16T00:00:00Z',
            description: 'MR body',
            sha: 'head-sha',
            head_pipeline: null,
            reviewers: []
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails(
      '/repo',
      12,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )

    expect(details?.item.number).toBe(12)
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo',
      undefined,
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(glabExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })
})
