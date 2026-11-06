import { describe, expect, it } from 'vitest'
import { ConnectorEventSchema } from './event-messages.js'
import { ConnectorHelloRequestSchema } from './hello-messages.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'

const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const

describe('events', () => {
  const turnEnded = {
    kind: 'turn-ended',
    conversation,
    paneKey: 'tab:leaf',
    turnId: 1_793_000_000_000,
    at: 1_793_000_060_000,
    stopReason: null
  }

  it('caps the last assistant message in UTF-8 bytes', () => {
    const limit = CONNECTOR_LIMITS.maxLastAssistantMessageBytes
    expect(
      ConnectorEventSchema.safeParse({ ...turnEnded, lastAssistantMessage: 'a'.repeat(limit) })
        .success
    ).toBe(true)
    expect(
      ConnectorEventSchema.safeParse({
        ...turnEnded,
        lastAssistantMessage: 'é'.repeat(limit / 2 + 1)
      }).success
    ).toBe(false)
  })
})

describe('hello and replies', () => {
  it('keeps capability entries the cloud does not know', () => {
    const hello = ConnectorHelloRequestSchema.parse({
      v: 1,
      contract: 1,
      orcaVersion: '1.4.230',
      platform: 'linux',
      runtime: 'serve',
      hostName: 'build-box',
      agents: ['claude', 'future-agent'],
      promptKinds: ['approval'],
      features: ['answer', 'future-feature'],
      sources: ['slack', 'future-source'],
      projects: [
        { placeId: 'pl_1', name: 'orca', kind: 'git', where: { kind: 'ssh', label: 'openclaw' } }
      ]
    })
    expect(hello.features).toEqual(['answer', 'future-feature'])
    expect(hello.sources).toEqual(['slack', 'future-source'])
  })

  it('caps a hello at maxHelloProjects projects with short display strings', () => {
    const project = (name: string) => ({
      placeId: 'pl_1',
      name,
      kind: 'folder',
      where: { kind: 'local' }
    })
    const hello = (projects: unknown[]) =>
      ConnectorHelloRequestSchema.safeParse({
        v: 1,
        contract: 1,
        orcaVersion: '1.4.230',
        platform: 'linux',
        runtime: 'desktop',
        hostName: 'build-box',
        agents: ['claude'],
        promptKinds: [],
        features: [],
        sources: ['slack'],
        projects
      }).success
    const longest = 'x'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength)
    expect(
      hello(Array.from({ length: CONNECTOR_LIMITS.maxHelloProjects }, () => project(longest)))
    ).toBe(true)
    expect(hello([project(`${longest}x`)])).toBe(false)
    expect(
      hello(Array.from({ length: CONNECTOR_LIMITS.maxHelloProjects + 1 }, () => project('orca')))
    ).toBe(false)
  })
})
