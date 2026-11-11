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
vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
import { closeMR, mergeMR, reopenMR, updateMR } from './client'
import { resetGitLabMrMocks } from './client-mr-test-harness'
import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  __resetHostedReviewBranchCacheForTests,
  withHostedReviewBranchCache
} from '../source-control/hosted-review-branch-cache'

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

  describe('glab state-change refusals', () => {
    const projectRef = { host: 'gitlab.com', path: 'g/p' }
    const mutations = { close: closeMR, reopen: reopenMR }

    it.each([
      ['close', 'this merge request has been closed', true],
      ['reopen', 'this merge request is already open.', true],
      ['close', 'this merge request has already been merged', false],
      ['reopen', 'this merge request has already been merged', false]
    ] as const)('%s refused with "%s" reports ok=%s', async (action, message, ok) => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error(message))

      await expect(mutations[action]('/repo', 6, undefined, null, projectRef)).resolves.toEqual(
        ok ? { ok: true } : { ok: false, error: message }
      )
    })
  })
})

describe('gitlab client — review lookups after a merge request write', () => {
  const projectRef = { host: 'gitlab.example.internal', path: 'g/p' }
  const identity = { repoPath: '/repo', executionHostId: 'local' as const, branch: 'feature' }
  const open: HostedReviewInfo = {
    provider: 'gitlab',
    number: 6,
    title: 'MR',
    state: 'open',
    url: 'https://gitlab.example.internal/g/p/-/merge_requests/6',
    status: 'neutral',
    updatedAt: '',
    mergeable: 'UNKNOWN'
  }
  const writes = {
    merge: () => mergeMR('/repo', 6, 'squash', undefined, null, projectRef),
    close: () => closeMR('/repo', 6, undefined, null, projectRef),
    reopen: () => reopenMR('/repo', 6, undefined, null, projectRef),
    title: () => updateMR('/repo', 6, { title: 'Renamed' }, undefined, null, projectRef)
  }

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
    __resetHostedReviewBranchCacheForTests()
    glabExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  // Issue #14377: "I press Squash and merge" in Orca, and the card stayed Open while a poll was in flight.
  it.each(Object.entries(writes))(
    '%s: the follow-up read starts after the write instead of joining an older poll',
    async (_name, write) => {
      const prePoll = Promise.withResolvers<HostedReviewInfo | null>()
      const poll = withHostedReviewBranchCache(
        identity,
        { headOid: null, force: true },
        () => prePoll.promise
      )
      await expect(write()).resolves.toEqual({ ok: true })
      const changed = { ...open, state: 'merged' as const }
      const afterWrite = vi.fn(async () => changed)
      const followUp = withHostedReviewBranchCache(
        identity,
        { headOid: null, force: true },
        afterWrite
      )
      prePoll.resolve(open)
      await poll
      await expect(followUp).resolves.toEqual(changed)
      expect(afterWrite).toHaveBeenCalledTimes(1)
    }
  )
})
