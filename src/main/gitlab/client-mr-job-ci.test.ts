import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getGlabKnownHostsMock,
  getProjectRefMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock,
  gitExecFileAsyncMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

// Why: the #9171 default-branch guard resolves the repo default branch via
// git; keep those probes hermetic instead of spawning real git processes.
vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    glabApiWithHeaders: glabApiWithHeadersMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    getProjectRef: getProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { getJobTrace, retryJob } from './client'
import { resetGitLabMrMocks } from './client-mr-test-harness'

describe('gitlab client — MR operations', () => {
  beforeEach(() => {
    resetGitLabMrMocks({
      glabExecFileAsyncMock,
      glabApiWithHeadersMock,
      getGlabKnownHostsMock,
      getProjectRefMock,
      resolveIssueSourceMock,
      acquireMock,
      releaseMock,
      gitExecFileAsyncMock
    })
  })

  describe('job CI operations', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('fetches a job trace through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'trace output' })

      await expect(getJobTrace('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        trace: 'trace output'
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--hostname', 'git.internal', 'projects/g%2Fp/jobs/99/trace'],
        {}
      )
    })

    // #7732: a job canceled before it started 404s; the Checks panel must show its
    // benign empty state, not the issue-edit copy classifyGlabError would produce.
    it('reports a 404 trace as an empty log rather than an error', async () => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404 Not Found'))

      await expect(getJobTrace('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        trace: ''
      })
    })

    it('keeps a missing project and a scope failure as errors, in job-log wording', async () => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Project Not Found'))
      await expect(getJobTrace('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: false,
        error: "Could not find this job's GitLab project."
      })

      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 403 insufficient_scope'))
      const forbidden = await getJobTrace('/repo', 99, 'upstream', 'conn-1')
      expect(forbidden).toEqual({
        ok: false,
        error: "You don't have permission to read this job's log. Check your GitLab token scopes."
      })
    })

    it('retries a job through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 100,
          pipeline: { id: 50 },
          name: 'test',
          stage: 'test',
          status: 'pending',
          web_url: 'https://git.internal/g/p/-/jobs/100',
          duration: null
        })
      })

      await expect(retryJob('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        job: {
          id: 100,
          pipelineId: 50,
          name: 'test',
          stage: 'test',
          status: 'pending',
          webUrl: 'https://git.internal/g/p/-/jobs/100',
          duration: null
        }
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--hostname', 'git.internal', '-X', 'POST', 'projects/g%2Fp/jobs/99/retry'],
        {}
      )
    })
  })
})
