import { describe, expect, it } from 'vitest'
import type { PlaneProject, PlaneState, PlaneWorkspace } from '../../shared/plane-types'
import {
  mapPlaneLabel,
  mapPlaneMember,
  mapPlaneProject,
  mapPlaneState,
  mapPlaneWorkItem
} from './work-item-mapping'

const workspace: PlaneWorkspace = {
  id: 'ws-1',
  slug: 'acme',
  name: 'acme',
  baseUrl: 'https://api.plane.so',
  appUrl: 'https://app.plane.so',
  deployment: 'cloud'
}

const project: PlaneProject = { id: 'p-1', identifier: 'PROJ', name: 'Platform' }

const expandedState = { id: 's-doing', name: 'In Progress', group: 'started', default: true }

function rawWorkItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wi-1',
    sequence_id: 123,
    name: 'Add OAuth login',
    description_html: '<p>Support <b>Google</b> &amp; GitHub.</p>',
    priority: 'high',
    state: expandedState,
    assignees: [{ id: 'u-1', display_name: 'Ada' }],
    labels: [{ id: 'l-1', name: 'backend' }],
    target_date: '2026-09-01',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    ...overrides
  }
}

describe('mapPlaneWorkItem', () => {
  it('builds the human key, browse url and plain-text description', () => {
    const item = mapPlaneWorkItem(rawWorkItem(), { workspace, project })
    expect(item).toMatchObject({
      id: 'wi-1',
      key: 'PROJ-123',
      sequenceId: 123,
      url: 'https://app.plane.so/acme/browse/PROJ-123/',
      description: 'Support Google & GitHub.',
      priority: 'high',
      workspaceId: 'ws-1'
    })
    expect(item?.state).toMatchObject({ id: 's-doing', group: 'started' })
    expect(item?.assignees.map((member) => member.displayName)).toEqual(['Ada'])
    expect(item?.labels.map((label) => label.name)).toEqual(['backend'])
  })

  it('falls back to a lookup when the deployment ignores expand', () => {
    const stateById = new Map<string, PlaneState>([
      ['s-doing', { id: 's-doing', name: 'In Progress', group: 'started' }]
    ])
    const item = mapPlaneWorkItem(rawWorkItem({ state: 's-doing' }), {
      workspace,
      project,
      stateById
    })
    expect(item?.state.name).toBe('In Progress')
  })

  it('returns null rather than inventing a state group it cannot resolve', () => {
    expect(mapPlaneWorkItem(rawWorkItem({ state: 's-unknown' }), { workspace, project })).toBeNull()
  })

  it('defaults an unrecognised priority to none', () => {
    expect(
      mapPlaneWorkItem(rawWorkItem({ priority: 'critical' }), { workspace, project })
    ).toMatchObject({ priority: 'none' })
  })

  it.each([
    ['non-object input', 'nope'],
    ['a missing id', { sequence_id: 1, state: expandedState }],
    ['a non-integer sequence id', { id: 'wi-1', sequence_id: 'x', state: expandedState }]
  ])('rejects %s', (_label, raw) => {
    expect(mapPlaneWorkItem(raw, { workspace, project })).toBeNull()
  })
})

describe('mapPlaneState', () => {
  it('keeps only the five documented state groups', () => {
    expect(mapPlaneState({ id: 's', name: 'Done', group: 'completed' })).toMatchObject({
      group: 'completed'
    })
    expect(mapPlaneState({ id: 's', name: 'Odd', group: 'invented' })).toBeNull()
  })
})

describe('mapPlaneProject', () => {
  it('upper-cases the identifier and stamps the workspace', () => {
    expect(mapPlaneProject({ id: 'p', identifier: 'proj', name: 'Platform' }, workspace)).toEqual({
      id: 'p',
      identifier: 'PROJ',
      name: 'Platform',
      workspaceId: 'ws-1',
      workspaceName: 'acme'
    })
  })

  it('rejects a project with no identifier', () => {
    expect(mapPlaneProject({ id: 'p', name: 'Platform' }, workspace)).toBeNull()
  })
})

describe('mapPlaneMember', () => {
  it('unwraps a nested workspace member row', () => {
    expect(mapPlaneMember({ member: { id: 'u-1', display_name: 'Ada' } })).toMatchObject({
      id: 'u-1',
      displayName: 'Ada'
    })
  })

  it('composes a name, then falls back to email, then id', () => {
    expect(mapPlaneMember({ id: 'u', first_name: 'Ada', last_name: 'L' })).toMatchObject({
      displayName: 'Ada L'
    })
    // Regression: an empty composed name is '' and would defeat a ?? chain.
    expect(mapPlaneMember({ id: 'u', email: 'ada@e.com' })).toMatchObject({
      displayName: 'ada@e.com'
    })
    expect(mapPlaneMember({ id: 'u' })).toMatchObject({ displayName: 'u' })
  })
})

describe('mapPlaneLabel', () => {
  it('names an unnamed label after its id', () => {
    expect(mapPlaneLabel({ id: 'l-1' })).toEqual({ id: 'l-1', name: 'l-1' })
    expect(mapPlaneLabel({ name: 'orphan' })).toBeNull()
  })
})
