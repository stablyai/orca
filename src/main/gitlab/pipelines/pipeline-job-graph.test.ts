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

it('tags only jobs from another project with their owner so trace/retry route there', async () => {
  vi.mocked(glabExecFileAsync).mockImplementation(async (args) => {
    const endpoint = args.find((arg) => arg.startsWith('projects/'))?.split('?')[0]
    const pages: Record<string, unknown[]> = {
      'projects/team%2Ffork/pipelines/1/jobs': [{ id: 11, name: 'build', status: 'success' }],
      'projects/team%2Ffork/pipelines/1/bridges': [
        {
          name: 'deployment',
          downstream_pipeline: {
            id: 2,
            project_id: 200,
            web_url: 'https://gitlab.example:8443/platform/deploy/-/pipelines/2'
          }
        },
        { name: 'tests', downstream_pipeline: { id: 3, project_id: 100 } },
        {
          name: 'lint',
          downstream_pipeline: {
            id: 4,
            project_id: 100,
            web_url: 'https://gitlab.example:8443/team/fork/-/pipelines/4'
          }
        }
      ],
      'projects/platform%2Fdeploy/pipelines/2/jobs': [
        { id: 21, name: 'publish', status: 'failed' }
      ],
      'projects/team%2Ffork/pipelines/3/jobs': [{ id: 31, name: 'unit', status: 'success' }],
      'projects/team%2Ffork/pipelines/4/jobs': [{ id: 41, name: 'eslint', status: 'success' }]
    }
    if (!endpoint || !pages[endpoint]) {
      throw new Error(`Unexpected GitLab endpoint: ${endpoint}`)
    }
    return {
      stdout: `HTTP/2 200 OK\r\nX-Next-Page: \r\n\r\n${JSON.stringify(pages[endpoint])}`,
      stderr: ''
    }
  })

  const jobs = await fetchPipelineJobs(
    '/checkout/upstream',
    { host: 'gitlab.example:8443', path: 'team/fork' },
    1
  )
  expect(
    jobs.filter((job) => job.id > 0).map(({ id, projectRef }) => ({ id, projectRef }))
  ).toStrictEqual([
    { id: 11, projectRef: undefined },
    { id: 21, projectRef: { host: 'gitlab.example:8443', path: 'platform/deploy' } },
    { id: 31, projectRef: undefined },
    { id: 41, projectRef: undefined }
  ])
})
