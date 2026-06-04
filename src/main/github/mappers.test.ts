import { describe, expect, it } from 'vitest'

import { deriveCheckStatus } from './mappers'

// Why: deriveCheckStatus feeds PRInfo.checksStatus (the green/red/yellow check
// indicator on PR cards). It must classify the same statusCheckRollup the way
// deriveWorkItemCheckSummary (client.ts) does, so the PR card and the work-item
// summary never disagree about whether a PR's checks are passing.
describe('deriveCheckStatus', () => {
  it('returns neutral for an empty or missing rollup', () => {
    expect(deriveCheckStatus(undefined)).toBe('neutral')
    expect(deriveCheckStatus(null)).toBe('neutral')
    expect(deriveCheckStatus([])).toBe('neutral')
  })

  it('returns success when every check passed', () => {
    expect(
      deriveCheckStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { state: 'SUCCESS' }
      ])
    ).toBe('success')
  })

  it('treats a FAILURE conclusion or state as failure', () => {
    expect(deriveCheckStatus([{ status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failure')
    expect(deriveCheckStatus([{ state: 'FAILURE' }])).toBe('failure')
  })

  it('reports pending while checks are still running', () => {
    expect(
      deriveCheckStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS' }
      ])
    ).toBe('pending')
  })

  // Why: GitHub check-run conclusions include ACTION_REQUIRED and
  // STARTUP_FAILURE, and commit statuses can report an ERROR conclusion. All
  // three are failing states per the repo's own canonical list in
  // deriveWorkItemCheckSummary (client.ts). Before the fix these fell through
  // to "success", silently showing a green check on a PR that is actually
  // blocked/failing.
  it('treats ACTION_REQUIRED as failure', () => {
    expect(deriveCheckStatus([{ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }])).toBe(
      'failure'
    )
  })

  it('treats STARTUP_FAILURE as failure', () => {
    expect(deriveCheckStatus([{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }])).toBe(
      'failure'
    )
  })

  it('treats an ERROR conclusion as failure', () => {
    expect(deriveCheckStatus([{ status: 'COMPLETED', conclusion: 'ERROR' }])).toBe('failure')
  })

  it('still flags failure when a failing check is mixed with passing ones', () => {
    expect(
      deriveCheckStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { state: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }
      ])
    ).toBe('failure')
  })
})
