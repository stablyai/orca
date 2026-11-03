import { beforeEach, describe, expect, it, vi } from 'vitest'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('./gl-utils', () => ({
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: vi.fn(() => ({}))
}))

import { fetchPipelineJobs } from './pipeline-job-graph'

const PROJECT = { host: 'gitlab.com', path: 'g/p' }

function rawJobs(start: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_, i) => ({ id: start + i, name: `job-${start + i}` }))
}

describe('fetchPipelineJobs pagination', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
  })

  it('keeps fetching jobs and bridges past the first 100-item page', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      switch (endpoint) {
        case 'projects/g%2Fp/pipelines/7/jobs?per_page=100':
          return { stdout: JSON.stringify(rawJobs(1, 100)) }
        case 'projects/g%2Fp/pipelines/7/jobs?per_page=100&page=2':
          return { stdout: JSON.stringify(rawJobs(101, 30)) }
        case 'projects/g%2Fp/pipelines/7/bridges?per_page=100':
          return {
            stdout: JSON.stringify(
              Array.from({ length: 100 }, (_, i) => ({ id: 0, name: `bridge-${i}` }))
            )
          }
        case 'projects/g%2Fp/pipelines/7/bridges?per_page=100&page=2':
          return { stdout: JSON.stringify([{ id: 0, name: 'bridge-100' }]) }
        default:
          throw new Error(`unexpected glab call: ${String(endpoint)}`)
      }
    })

    const jobs = await fetchPipelineJobs('/repo', PROJECT, 7)

    expect(jobs.filter((job) => job.id !== 0)).toHaveLength(130)
    expect(jobs.filter((job) => job.name.startsWith('bridge-'))).toHaveLength(101)
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(4)
  })

  it('stops after a short first page', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
      stdout: JSON.stringify(String(args.at(-1)).includes('/jobs') ? rawJobs(1, 99) : [])
    }))

    const jobs = await fetchPipelineJobs('/repo', PROJECT, 7)

    expect(jobs).toHaveLength(99)
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
