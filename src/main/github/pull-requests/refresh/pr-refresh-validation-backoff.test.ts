import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordCoalescedCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordCoalescedCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../../../crash-reporting/breadcrumbs/crash-breadcrumb-store', () => ({
  recordCoalescedCrashBreadcrumb: recordCoalescedCrashBreadcrumbMock
}))

import {
  clearPRRefreshValidationBackoffForTests,
  notePRRefreshValidationDenial
} from './pr-refresh-validation-backoff'

describe('PR refresh validation backoff', () => {
  beforeEach(() => {
    clearPRRefreshValidationBackoffForTests()
    recordCoalescedCrashBreadcrumbMock.mockReset()
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
