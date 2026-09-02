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

import { _getGitLabRateLimitCacheSize, diagnoseAuth, getRateLimit } from './client'
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

  describe('diagnoseAuth', () => {
    it('reports glab hosts from auth status', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.com as alice\n',
        stderr: ''
      })

      await expect(diagnoseAuth()).resolves.toMatchObject({
        glabAvailable: true,
        authenticated: true,
        hosts: ['gitlab.com'],
        activeHost: 'gitlab.com'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {
        allowDefaultWslFallback: false
      })
    })

    it('merges many authenticated hosts with one cache scan', async () => {
      const hostCount = 256
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: Array.from(
          { length: hostCount },
          (_, index) => `Logged in to gitlab-${index}.example.test as user`
        ).join('\n'),
        stderr: ''
      })
      const originalMap = Array.prototype.map
      let knownHostCacheScans = 0
      const mapSpy = vi.spyOn(Array.prototype, 'map').mockImplementation(function (
        this: unknown[],
        callback: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown
      ): unknown[] {
        if (this[0] === 'gitlab.com' && this.every((value) => typeof value === 'string')) {
          knownHostCacheScans += 1
        }
        return Reflect.apply(originalMap, this, [callback, thisArg])
      })

      try {
        await expect(diagnoseAuth()).resolves.toMatchObject({
          authenticated: true,
          hosts: expect.any(Array)
        })
      } finally {
        mapSpy.mockRestore()
      }
      expect(knownHostCacheScans).toBe(1)
    })
  })

  describe('getRateLimit', () => {
    it('parses GitLab REST budget headers', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: '{}',
        headers: {
          'ratelimit-limit': '2000',
          'ratelimit-remaining': '1997',
          'ratelimit-reset': '1780000000'
        }
      })

      await expect(
        getRateLimit({ host: 'gitlab.example.com', force: true })
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          host: 'gitlab.example.com',
          rest: {
            limit: 2000,
            remaining: 1997,
            resetAt: 1780000000
          }
        }
      })
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith([
        '--hostname',
        'gitlab.example.com',
        'user'
      ])
    })

    it('reports a null bucket when the host omits rate-limit headers', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '{}', headers: {} })

      await expect(getRateLimit({ force: true })).resolves.toMatchObject({
        ok: true,
        snapshot: { host: null, rest: null }
      })
    })

    it('bounds cached rate-limit snapshots across many hosts', async () => {
      glabApiWithHeadersMock.mockResolvedValue({ body: '{}', headers: {} })

      for (let i = 0; i < 70; i++) {
        await getRateLimit({ host: `gitlab-${i}.example.com`, force: true })
      }

      expect(_getGitLabRateLimitCacheSize()).toBe(64)
    })
  })
})
