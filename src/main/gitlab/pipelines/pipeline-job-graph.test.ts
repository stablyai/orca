import { expect, it, vi } from 'vitest'
import { fetchPipelineJobs } from './pipeline-job-graph'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn()
}))

it('keeps an unreadable child rollup when another pipeline has a job with the same name', async () => {
  vi.mocked(glabExecFileAsync).mockImplementation(async (args) => {
    const endpoint = args.find((arg) => arg.startsWith('projects/'))?.split('?')[0]
    const pages: Record<string, unknown[]> = {
      'projects/team%2Fapp/pipelines/1/jobs': [{ id: 11, name: 'build', status: 'success' }],
      'projects/team%2Fapp/pipelines/1/bridges': [
        {
          name: 'frontend',
          status: 'success',
          downstream_pipeline: {
            id: 2,
            status: 'success',
            web_url: 'https://gitlab.example/team/app/-/pipelines/2'
          }
        },
        {
          name: 'backend',
          status: 'success',
          downstream_pipeline: {
            id: 3,
            status: 'failed',
            web_url: 'https://gitlab.example/team/private/-/pipelines/3'
          }
        }
      ],
      'projects/team%2Fapp/pipelines/2/jobs': [
        { id: 21, name: 'frontend', status: 'success' },
        { id: 22, name: 'backend', status: 'success' }
      ]
    }
    if (endpoint === 'projects/team%2Fprivate/pipelines/3/jobs') {
      throw new Error('HTTP 403 Forbidden')
    }
    if (!endpoint || !pages[endpoint]) {
      throw new Error(`Unexpected GitLab endpoint: ${endpoint}`)
    }
    return {
      stdout: `HTTP/2 200 OK\r\nX-Next-Page: \r\n\r\n${JSON.stringify(pages[endpoint])}`,
      stderr: ''
    }
  })

  const jobs = await fetchPipelineJobs('/repo', { host: 'gitlab.example', path: 'team/app' }, 1)
  expect(jobs.map(({ id, name, status }) => ({ id, name, status }))).toEqual([
    { id: 11, name: 'build', status: 'success' },
    { id: 21, name: 'frontend', status: 'success' },
    { id: 22, name: 'backend', status: 'success' },
    { id: 0, name: 'backend', status: 'failed' }
  ])
  expect(jobs.at(-1)?.webUrl).toBe('https://gitlab.example/team/private/-/pipelines/3')
})
