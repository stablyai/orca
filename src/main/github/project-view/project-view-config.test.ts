import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchProjectViewsPage,
  finalizeView,
  resetVerticalGroupByCapabilityForTests,
  type RawProjectView
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
  it('drops the selection and retries once on an unknown-field error', async () => {
    vi.mocked(runGraphql)
      .mockResolvedValueOnce(unknownFieldFailure())
      .mockResolvedValueOnce(okPage())
    const result = await fetchProjectViewsPage(args)
    expect(result.ok).toBe(true)
    expect(vi.mocked(runGraphql).mock.calls[0]?.[0]).toContain('verticalGroupByFields')
    expect(vi.mocked(runGraphql).mock.calls[1]?.[0]).not.toContain('verticalGroupByFields')
  })

  it('memoizes the incapability per host and keeps other hosts unaffected', async () => {
    vi.mocked(runGraphql).mockResolvedValueOnce(unknownFieldFailure()).mockResolvedValue(okPage())
    await fetchProjectViewsPage(args)
    await fetchProjectViewsPage(args)
    // Third call overall = first call of the second fetch: no failed probe repeated.
    expect(vi.mocked(runGraphql).mock.calls[2]?.[0]).not.toContain('verticalGroupByFields')
    await fetchProjectViewsPage({ ...args, host: 'github.com' })
    expect(vi.mocked(runGraphql).mock.calls[3]?.[0]).toContain('verticalGroupByFields')
  })

  it('passes unrelated failures through without retrying', async () => {
    vi.mocked(runGraphql).mockResolvedValueOnce({
      ok: false,
      error: { type: 'network_error', message: 'Network error — check your connection.' },
      raw: { stderr: 'connect ETIMEDOUT', stdout: '' }
    })
    const result = await fetchProjectViewsPage(args)
    expect(result.ok).toBe(false)
    expect(vi.mocked(runGraphql)).toHaveBeenCalledTimes(1)
  })

  it('does not treat the field name inside partial-error DATA as incapability', async () => {
    // Why: partial errors echo the whole body, where the field name appears as
    // a plain data key on healthy schemas — that must not degrade the host.
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

describe('finalizeView verticalGroupByFields normalization', () => {
  const base: RawProjectView = {
    id: 'PVTV_1',
    number: 1,
    name: 'Board',
    layout: 'BOARD_LAYOUT',
    filter: null,
    fields: { nodes: [] },
    groupByFields: { nodes: [] },
    sortByFields: { nodes: [] }
  }

  it('normalizes present vertical fields and drops invalid nodes', () => {
    const finalized = finalizeView(
      {
        ...base,
        verticalGroupByFields: {
          nodes: [
            {
              __typename: 'ProjectV2SingleSelectField',
              id: 'f_status',
              name: 'Status',
              dataType: 'SINGLE_SELECT',
              options: []
            },
            null,
            { __typename: 'ProjectV2Field' }
          ]
        }
      },
      []
    )
    expect(finalized.ok).toBe(true)
    if (finalized.ok) {
      expect(finalized.view.verticalGroupByFields).toEqual([
        {
          kind: 'single-select',
          id: 'f_status',
          name: 'Status',
          dataType: 'SINGLE_SELECT',
          options: []
        }
      ])
    }
  })

  it('omits the key entirely when the host never sent it (wire-compat shape)', () => {
    const finalized = finalizeView(base, [])
    expect(finalized.ok).toBe(true)
    if (finalized.ok) {
      expect('verticalGroupByFields' in finalized.view).toBe(false)
    }
  })
})
