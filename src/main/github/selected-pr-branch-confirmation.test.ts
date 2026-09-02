import { describe, expect, it, vi } from 'vitest'
import { confirmsSelectedGitHubPrByNumber } from './selected-pr-branch-confirmation'

const pr = (overrides: Record<string, unknown> = {}) =>
  ({
    number: 42,
    title: 'Upstream PR',
    state: 'open',
    url: 'https://example.com/pr/42',
    checksStatus: 'success',
    updatedAt: '2026-06-16T00:00:00.000Z',
    mergeable: 'UNKNOWN',
    headRefName: 'feature/fix',
    ...overrides
  }) as never

describe('confirmsSelectedGitHubPrByNumber', () => {
  const base = {
    linkedPR: 42,
    branchNameOverride: 'feature/fix',
    branchName: 'feature/fix'
  }

  it('confirms when the selected PR heads this branch', async () => {
    const lookupByNumber = vi.fn().mockResolvedValue(pr())

    await expect(confirmsSelectedGitHubPrByNumber({ ...base, lookupByNumber })).resolves.toBe(true)
    expect(lookupByNumber).toHaveBeenCalledWith(42)
  })

  it('rejects when the selected PR heads a different branch', async () => {
    const lookupByNumber = vi.fn().mockResolvedValue(pr({ headRefName: 'someone/else' }))

    await expect(confirmsSelectedGitHubPrByNumber({ ...base, lookupByNumber })).resolves.toBe(false)
  })

  it('rejects when the branch name override is not the branch being created', async () => {
    const lookupByNumber = vi.fn().mockResolvedValue(pr())

    await expect(
      confirmsSelectedGitHubPrByNumber({ ...base, branchName: 'feature/fix-2', lookupByNumber })
    ).resolves.toBe(false)
    // Why: the override mismatch is decided before any request goes out.
    expect(lookupByNumber).not.toHaveBeenCalled()
  })

  it('rejects without a selected review, and asks nothing', async () => {
    const lookupByNumber = vi.fn().mockResolvedValue(pr())

    await expect(
      confirmsSelectedGitHubPrByNumber({ ...base, linkedPR: null, lookupByNumber })
    ).resolves.toBe(false)
    expect(lookupByNumber).not.toHaveBeenCalled()
  })

  it('rejects when the lookup finds nothing', async () => {
    const lookupByNumber = vi.fn().mockResolvedValue(null)

    await expect(confirmsSelectedGitHubPrByNumber({ ...base, lookupByNumber })).resolves.toBe(false)
  })

  it('rejects when the lookup throws', async () => {
    const lookupByNumber = vi.fn().mockRejectedValue(new Error('gh unavailable'))

    await expect(confirmsSelectedGitHubPrByNumber({ ...base, lookupByNumber })).resolves.toBe(false)
  })
})
