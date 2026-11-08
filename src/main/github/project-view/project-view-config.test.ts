import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchProjectViewsPage,
  resetVerticalGroupByCapabilityForTests
} from './project-view-config'
import { runGraphql } from './internals'
import type * as Internals from './internals'

vi.mock('./internals', async (importOriginal) => ({
  ...(await importOriginal<typeof Internals>()),
  runGraphql: vi.fn()
}))

const args = {
  owner: 'acme',
  ownerType: 'organization',
  projectNumber: 1,
  host: 'ghes.acme.test',
  after: null
} as const

function okPage() {
  return {
    ok: true as const,
    data: {
      organization: {
        projectV2: {
          id: 'PVT_1',
          title: 'Plan',
          url: 'https://ghes.acme.test/orgs/acme/projects/1',
          views: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      }
    }
  }
}

function unknownFieldFailure() {
  return {
    ok: false as const,
    error: { type: 'schema_drift' as const, message: 'Could not read this project view.' },
    raw: {
      stderr: '',
      stdout: JSON.stringify({
        errors: [
          {
            message: "Field 'verticalGroupByFields' doesn't exist on type 'ProjectV2View'"
          }
        ]
      })
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  resetVerticalGroupByCapabilityForTests()
})

describe('verticalGroupByFields capability fallback', () => {
  it('memoizes the incapability per host and keeps other hosts unaffected', async () => {
    vi.mocked(runGraphql).mockResolvedValueOnce(unknownFieldFailure()).mockResolvedValue(okPage())
    await fetchProjectViewsPage(args)
    await fetchProjectViewsPage(args)
    expect(vi.mocked(runGraphql).mock.calls[2]?.[0]).not.toContain('verticalGroupByFields')
    await fetchProjectViewsPage({ ...args, host: 'github.com' })
    expect(vi.mocked(runGraphql).mock.calls[3]?.[0]).toContain('verticalGroupByFields')
  })

  it('does not cache authorization or transient errors that mention the field', async () => {
    vi.mocked(runGraphql)
      .mockResolvedValueOnce({
        ok: false,
        error: { type: 'scope_missing', message: 'Not authorized' },
        raw: {
          stderr: '',
          stdout: JSON.stringify({
            errors: [{ message: 'Not authorized to access verticalGroupByFields' }]
          })
        }
      })
      .mockResolvedValue(okPage())
    expect((await fetchProjectViewsPage(args)).ok).toBe(false)
    expect(runGraphql).toHaveBeenCalledTimes(1)
    await fetchProjectViewsPage(args)
    expect(vi.mocked(runGraphql).mock.calls[1]?.[0]).toContain('verticalGroupByFields')
  })

  it('does not treat the field name inside partial-error DATA as incapability', async () => {
    // Partial-error data can echo a healthy field name; only schema errors prove it unsupported.
    vi.mocked(runGraphql).mockResolvedValueOnce({
      ok: false,
      error: { type: 'schema_drift', message: 'Could not read this project view.' },
      raw: {
        stderr: '',
        stdout: JSON.stringify({
          data: {
            organization: { projectV2: { views: { nodes: [{ verticalGroupByFields: {} }] } } }
          },
          errors: [{ message: 'SAML enforcement: resource protected by organization policy' }]
        })
      }
    })
    const result = await fetchProjectViewsPage(args)
    expect(result.ok).toBe(false)
    expect(vi.mocked(runGraphql)).toHaveBeenCalledTimes(1)
  })
})
