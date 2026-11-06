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
import { listMergeRequests } from './client'
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

  describe('listMergeRequests', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'gitlab.com', path: 'g/p' },
        fellBack: false
      }))
    })

    it('filters by the signed-in reviewer on the project host with the list call options', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { host: 'gitlab.example.com:8443', path: 'g/p' },
        fellBack: false
      })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{"id":42,"username":"me"}' })
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: '[{"iid":8,"title":"Review me","state":"opened"}]',
        headers: { 'x-total': '1', 'x-total-pages': '1' }
      })

      const result = await listMergeRequests(
        '/repo',
        'opened',
        1,
        20,
        undefined,
        undefined,
        null,
        { wslDistro: 'Ubuntu' },
        { involvement: 'reviewing' }
      )

      expect(result.items.map((item) => item.number)).toEqual([8])
      const options = { cwd: '/repo', wslDistro: 'Ubuntu' }
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--hostname', 'gitlab.example.com:8443', 'user'],
        options
      )
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
        [
          '--hostname',
          'gitlab.example.com:8443',
          'projects/g%2Fp/merge_requests?page=1&per_page=20&order_by=updated_at&sort=desc&with_merge_status_recheck=false&state=opened&reviewer_id=42'
        ],
        options
      )
    })

    it.each([
      [
        'a signed-out lookup',
        () => Promise.reject(new Error('401 Unauthorized')),
        'permission_denied'
      ],
      [
        'a network failure on a host whose port contains 401',
        () =>
          Promise.reject(
            new Error('Get "https://gitlab.corp:4010/api/v4/user": dial tcp: connection refused')
          ),
        'unknown'
      ],
      [
        'a lookup without a user id',
        () => Promise.resolve({ stdout: '{"message":"ok"}' }),
        'unknown'
      ]
    ])(
      'reports an error instead of listing everyone after %s',
      async (_label, lookup, expectedType) => {
        glabExecFileAsyncMock.mockImplementationOnce(lookup)

        const result = await listMergeRequests(
          '/repo',
          'opened',
          1,
          20,
          undefined,
          undefined,
          null,
          {},
          { involvement: 'authored' }
        )

        expect(result.items).toEqual([])
        expect(result.error?.type).toBe(expectedType)
        expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
        expect(releaseMock).toHaveBeenCalled()
      }
    )

    it.each([null, 'ssh-1'])(
      'shows a visible error for a filtered list whose project is unresolved (connection %s)',
      async (connectionId) => {
        resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })

        const result = await listMergeRequests(
          '/repo',
          'opened',
          1,
          20,
          undefined,
          undefined,
          connectionId,
          {},
          { involvement: 'authored' }
        )

        expect(result.error?.type).toBe('unknown')
        expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
      }
    )

    it('does not run the cwd fallback for unresolved SSH repos', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      const result = await listMergeRequests(
        '/remote/repo',
        'opened',
        1,
        20,
        undefined,
        undefined,
        'conn-1'
      )
      expect(result.error?.type).toBe('not_found')
      expect(result.items).toEqual([])
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
      expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
    })

    // A classifier keyword in a content title must not replace the opaque response diagnostic.

    // Only the envelope message is diagnostic; sibling payload keywords must not change classification.
  })
})
