import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonWithHeadersMock } = vi.hoisted(() => ({
  requestGiteaJsonWithHeadersMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJsonWithHeaders: requestGiteaJsonWithHeadersMock
}))

import { fetchGiteaPipelineJobs } from './actions-job-graph'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

describe('fetchGiteaPipelineJobs', () => {
  beforeEach(() => {
    requestGiteaJsonWithHeadersMock.mockReset()
  })

  it('maps Actions jobs for the head SHA and keeps external commit statuses', async () => {
    requestGiteaJsonWithHeadersMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/actions/runs') {
        return {
          data: {
            workflow_runs: [
              {
                id: 9,
                name: 'CI',
                head_sha: 'abc',
                html_url: 'https://git.example.com/team/widgets/actions/runs/9',
                status: 'success'
              },
              {
                id: 8,
                name: 'Old',
                head_sha: 'other',
                status: 'failure'
              }
            ]
          },
          headers: {}
        }
      }
      if (path === '/repos/team/widgets/actions/runs/9/jobs') {
        return {
          data: {
            jobs: [
              {
                id: 41,
                name: 'test',
                status: 'success',
                html_url: 'https://git.example.com/team/widgets/actions/runs/9/jobs/41',
                started_at: '2026-05-01T00:00:00.000Z',
                completed_at: '2026-05-01T00:01:30.000Z'
              },
              {
                id: 41,
                name: 'test',
                status: 'success',
                html_url: 'https://git.example.com/team/widgets/actions/runs/9/jobs/41'
              }
            ]
          },
          headers: {}
        }
      }
      if (path === '/repos/team/widgets/commits/abc/statuses') {
        return {
          data: [
            {
              context: 'CI / test (pull_request)',
              status: 'success',
              target_url: 'https://git.example.com/team/widgets/actions/runs/9/jobs/41'
            },
            {
              context: 'woodpecker',
              status: 'failure',
              target_url: 'https://ci.example/builds/1'
            }
          ],
          headers: {}
        }
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const jobs = await fetchGiteaPipelineJobs(repo, 'abc', 'conn-1', {})

    expect(jobs).toEqual([
      {
        id: 41,
        runId: 9,
        name: 'test',
        stage: 'CI',
        status: 'success',
        webUrl: 'https://git.example.com/team/widgets/actions/runs/9/jobs/41',
        duration: 90
      },
      {
        id: 0,
        name: 'woodpecker',
        stage: '',
        status: 'failure',
        webUrl: 'https://ci.example/builds/1',
        duration: null
      }
    ])
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/actions/runs',
      {
        searchParams: { page: 1, limit: 50, head_sha: 'abc' },
        allowNotFound: true
      }
    )
    expect(requestGiteaJsonWithHeadersMock).not.toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/actions/runs/8/jobs',
      expect.anything()
    )
  })

  it('synthesizes check rows from commit statuses when Actions returns 404', async () => {
    requestGiteaJsonWithHeadersMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/actions/runs') {
        throw new Error('Gitea request failed: HTTP 404')
      }
      if (path === '/repos/team/widgets/commits/abc/statuses') {
        return {
          data: [
            {
              context: 'drone',
              state: 'pending',
              target_url: 'https://drone.example/1'
            }
          ],
          headers: {}
        }
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    await expect(fetchGiteaPipelineJobs(repo, 'abc')).resolves.toEqual([
      {
        id: 0,
        name: 'drone',
        stage: '',
        status: 'pending',
        webUrl: 'https://drone.example/1',
        duration: null
      }
    ])
    const paths = requestGiteaJsonWithHeadersMock.mock.calls.map((call) => call[1])
    expect(paths).not.toContain('/repos/team/widgets/actions/runs/9/jobs')
  })
})
