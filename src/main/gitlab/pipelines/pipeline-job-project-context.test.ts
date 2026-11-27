import { expect, it, vi } from 'vitest'
import { fetchPipelineJobs } from './pipeline-job-graph'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn()
}))

it('retains each job owner when a fork pipeline expands a different project', async () => {
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
        { name: 'tests', downstream_pipeline: { id: 3, project_id: 100 } }
      ],
      'projects/platform%2Fdeploy/pipelines/2/jobs': [
        { id: 21, name: 'publish', status: 'failed' }
      ],
      'projects/team%2Ffork/pipelines/3/jobs': [{ id: 31, name: 'unit', status: 'success' }]
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
  ).toEqual([
    { id: 11, projectRef: { host: 'gitlab.example:8443', path: 'team/fork' } },
    { id: 21, projectRef: { host: 'gitlab.example:8443', path: 'platform/deploy' } },
    { id: 31, projectRef: { host: 'gitlab.example:8443', path: 'team/fork' } }
  ])
})
