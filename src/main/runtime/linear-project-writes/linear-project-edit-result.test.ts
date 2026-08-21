import { describe, expect, it } from 'vitest'
import { buildLinearProjectEditResult } from './linear-project-edit-result'
import type { LinearProjectInternalSnapshot } from '../../linear/project-field-snapshot'

const PROJECT = {
  id: '0f3a1c9e-2b7d-4a51-9c62-8d5f0e7b4a13',
  name: 'Aurora',
  slugId: 'aurora-1a2b',
  url: 'https://linear.app/acme/project/aurora-1a2b'
}
const WORKSPACE_ID = 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b'
const ADA = { id: 'user-1', displayName: 'Ada', avatarUrl: null }

function snapshot(
  overrides: Partial<LinearProjectInternalSnapshot> = {}
): LinearProjectInternalSnapshot {
  return {
    name: 'Aurora',
    description: 'short summary',
    content: null,
    status: { id: 'status-1', name: 'Planned', type: 'planned', color: '#000000' },
    lead: null,
    members: [],
    teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }],
    labels: [],
    priority: 0,
    startDate: null,
    targetDate: null,
    color: '#5E6AD2',
    icon: null,
    ...overrides
  }
}

describe('buildLinearProjectEditResult', () => {
  it('publishes bounded previous/current for every requested field and only real changes', () => {
    const previous = snapshot()
    const current = snapshot({ description: 'new summary', lead: ADA })

    const result = buildLinearProjectEditResult({
      project: PROJECT,
      workspaceId: WORKSPACE_ID,
      requested: ['description', 'lead', 'priority'],
      edits: { description: 'new summary', leadId: ADA.id, priority: 0 },
      previous,
      current,
      noop: false
    })

    expect(result.changed).toEqual(['description', 'lead'])
    expect(result.previous).toEqual({
      description: {
        value: 'short summary',
        truncated: false,
        chars: 'short summary'.length,
        sha256: expect.any(String)
      },
      lead: null,
      priority: 0
    })
    expect(result.current.lead).toEqual(ADA)
    expect(result.current.description?.value).toBe('new summary')
    // Why: an unrequested field must never leak into the projection.
    expect(result.current).not.toHaveProperty('name')
    expect(result.meta).toEqual({ workspaceId: WORKSPACE_ID, noop: false })
  })

  it('reports a settled edit as a no-op with identical previous and current', () => {
    const previous = snapshot()

    const result = buildLinearProjectEditResult({
      project: PROJECT,
      workspaceId: WORKSPACE_ID,
      requested: ['name', 'members'],
      edits: { name: 'Aurora', memberIds: [] },
      previous,
      current: previous,
      noop: true
    })

    expect(result.changed).toEqual([])
    expect(result.meta.noop).toBe(true)
    expect(result.previous.members).toEqual({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
      sha256: expect.any(String)
    })
    expect(result.current).toEqual(result.previous)
  })
})
