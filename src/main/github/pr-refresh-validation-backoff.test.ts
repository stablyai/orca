import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordCoalescedCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordCoalescedCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCoalescedCrashBreadcrumb: recordCoalescedCrashBreadcrumbMock
}))

import {
  clearPRRefreshValidationBackoffForTests,
  getPRRefreshValidationBackoffCountForTests,
  notePRRefreshValidationDenial
} from './pr-refresh-validation-backoff'

describe('PR refresh validation backoff', () => {
  beforeEach(() => {
    clearPRRefreshValidationBackoffForTests()
    recordCoalescedCrashBreadcrumbMock.mockReset()
  })

  it('backs off repeated automatic validation denials until the TTL expires', () => {
    const identity = {
      repoId: 'repo-1',
      repoPath: '/workspace/missing',
      reason: 'unknown-repo' as const
    }

    expect(notePRRefreshValidationDenial(identity, 0)).toBe('validation-denied')
    expect(notePRRefreshValidationDenial(identity, 60_000)).toBe('validation-backoff')
    expect(notePRRefreshValidationDenial(identity, 5 * 60_000 + 1)).toBe('validation-denied')
  })

  it('bounds validation backoff entries', () => {
    for (let index = 0; index < 257; index += 1) {
      notePRRefreshValidationDenial(
        {
          repoId: `repo-${index}`,
          repoPath: `/workspace/missing-${index}`,
          reason: 'unknown-repo'
        },
        index
      )
    }

    expect(getPRRefreshValidationBackoffCountForTests()).toBe(256)
  })

  it('records path-safe diagnostic breadcrumbs', () => {
    notePRRefreshValidationDenial(
      {
        repoId: 'repo-1',
        repoPath: '/Users/alice/private/project',
        reason: 'repo-path-mismatch'
      },
      0
    )

    expect(recordCoalescedCrashBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'pr_refresh_validation_skip',
        data: expect.objectContaining({
          reason: 'repo-path-mismatch',
          result: 'recorded',
          token: expect.any(String)
        })
      })
    )
    const payload = recordCoalescedCrashBreadcrumbMock.mock.calls[0]?.[0]
    expect(JSON.stringify(payload)).not.toContain('/Users/alice/private/project')
  })
})
