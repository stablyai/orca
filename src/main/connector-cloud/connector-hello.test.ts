import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorProject
} from '../../shared/connector-cloud-contract'
import { connectorHello } from './connector-hello'
import { fakeMachine } from './fake-connector-seam.test-fixture'

const longest = (unit: string): string =>
  unit.repeat(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength / unit.length)

// Every string at its cap, in characters JSON escapes to six bytes each.
function largestProject(index: number): ConnectorProject {
  return {
    placeId: String(index).padStart(512, 'p'),
    name: longest('\u0001'),
    remote: longest('\u0001'),
    kind: 'git',
    where: { kind: 'ssh', label: longest('\u0001') }
  }
}

describe('connectorHello', () => {
  it('always fits the request cap, keeping the most recently used projects first', () => {
    const projects = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloProjects }, (_, index) =>
      largestProject(index)
    )
    const { body, trimmed } = connectorHello(
      fakeMachine(() => null),
      {
        agents: ['claude', 'codex'],
        projects
      }
    )
    const json = JSON.stringify(body)
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(CONNECTOR_CLIENT_LIMITS.maxRequestBytes)
    expect(trimmed).toBe(true)
    const sent = z.object({ projects: z.array(z.unknown()) }).parse(JSON.parse(json)).projects
    expect(sent.length).toBeGreaterThan(0)
    expect(sent).toEqual(projects.slice(0, sent.length))
  })

  it('sends every project when they fit', () => {
    const project: ConnectorProject = {
      placeId: 'pl_1',
      name: longest('a'),
      kind: 'folder',
      where: { kind: 'local' }
    }
    const projects = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloProjects }, () => project)
    const { body, trimmed } = connectorHello(
      fakeMachine(() => null),
      { agents: [], projects }
    )
    expect(trimmed).toBe(false)
    expect(body).toMatchObject({ projects })
  })
})
