import { describe, expect, it } from 'vitest'
import {
  PLANE_PROVIDER_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { PLANE_METHODS } from './plane'

describe('plane runtime capability', () => {
  it('is advertised by getStatus, or every remote Plane call is refused', () => {
    // Regression: the constant existed but was never added to the array
    // getStatus() filters, so runtimeEnvironmentSupportsCapability returned
    // false and the renderer refused every remote call against a host that
    // had all the plane.* methods.
    expect(RUNTIME_CAPABILITIES).toContain(PLANE_PROVIDER_RUNTIME_CAPABILITY)
  })

  it('covers the whole provider surface the renderer client calls', () => {
    const names = PLANE_METHODS.map((method) => method.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'plane.connect',
        'plane.disconnect',
        'plane.status',
        'plane.selectWorkspace',
        'plane.testConnection',
        'plane.listProjects',
        'plane.listStates',
        'plane.listLabels',
        'plane.listMembers',
        'plane.listWorkItems',
        'plane.getWorkItem',
        'plane.searchWorkItems',
        'plane.workItemComments',
        'plane.updateWorkItem',
        'plane.addComment',
        'plane.createWorkItem'
      ])
    )
    expect(names.every((name) => name.startsWith('plane.'))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
})

function paramsFor(name: string) {
  const method = PLANE_METHODS.find((entry) => entry.name === name)
  if (!method?.params) {
    throw new Error(`no params schema for ${name}`)
  }
  return method.params
}

describe('rpc argument bounds', () => {
  const project = { id: 'p-1', identifier: 'proj' }

  it('normalizes the echoed project so handlers get a complete record', () => {
    const parsed = paramsFor('plane.listWorkItems').parse({ project }) as {
      project: { id: string; identifier: string; name: string }
    }
    expect(parsed.project).toEqual({ id: 'p-1', identifier: 'PROJ', name: 'PROJ' })
  })

  it.each([
    ['plane.listWorkItems', 0],
    ['plane.listWorkItems', -1],
    ['plane.searchWorkItems', 0],
    ['plane.searchWorkItems', 101]
  ])('%s rejects an out-of-range limit of %s', (name, limit) => {
    // Regression: an unclamped limit of 0 returned an empty list flagged as
    // truncated, and a negative limit silently dropped the last row.
    const payload = name === 'plane.listWorkItems' ? { project, limit } : { search: 'x', limit }
    expect(() => paramsFor(name).parse(payload)).toThrow()
  })

  it.each([
    ['plane.listWorkItems', 250],
    ['plane.searchWorkItems', 100]
  ])('%s accepts its documented maximum of %s', (name, limit) => {
    const payload = name === 'plane.listWorkItems' ? { project, limit } : { search: 'x', limit }
    expect(() => paramsFor(name).parse(payload)).not.toThrow()
  })

  it('requires the fields an operation cannot work without', () => {
    expect(() => paramsFor('plane.connect').parse({ baseUrl: 'x', apiToken: 'y' })).toThrow()
    expect(() => paramsFor('plane.addComment').parse({ project, workItemId: 'w' })).toThrow()
    expect(() => paramsFor('plane.updateWorkItem').parse({ project, updates: {} })).toThrow()
  })
})
