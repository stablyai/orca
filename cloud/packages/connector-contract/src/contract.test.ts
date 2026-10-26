import { describe, expect, it } from 'vitest'
import {
  ConnectorDeliverySchema,
  ConnectorPollResponseSchema,
  ConnectorAcksRequestSchema
} from './delivery-messages.js'
import {
  ConnectorEventSchema,
  ConnectorEventsRequestSchema,
  ConnectorPendingPromptSchema,
  ConnectorReplyResponseSchema
} from './event-messages.js'
import { ConnectorHelloRequestSchema, ConnectorHelloResponseSchema } from './hello-messages.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'

const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const
const base = { deliveryId: 'T1:C9:1793.0001', seq: 41, expiresAt: 1_793_000_300_000, conversation }
const start = { ...base, kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
const poll = (deliveries: unknown[], extra: object = {}) =>
  ConnectorPollResponseSchema.safeParse({
    v: 1,
    serverNow: 1_793_000_000_000,
    holdMs: 50_000,
    deliveries,
    ...extra
  })

describe('poll response', () => {
  it('parses every known delivery kind and drops unknown fields', () => {
    const result = poll([
      { ...start, addedLater: true },
      { ...base, kind: 'send', text: 'more' },
      { ...base, kind: 'answer', promptId: 'p7', optionId: 'allow_once' },
      { ...base, kind: 'cancel' }
    ])
    expect(result.success && result.data.deliveries.map((d) => d.kind)).toEqual([
      'start',
      'send',
      'answer',
      'cancel'
    ])
    expect(result.data?.deliveries[0]).not.toHaveProperty('addedLater')
    expect(result.data?.control).toBeUndefined()
  })

  it('rejects a delivery the cloud must never send', () => {
    for (const delivery of [
      { ...base, kind: 'rewind' },
      { ...start, prompt: '' },
      { deliveryId: base.deliveryId },
      { ...base, conversation: { source: 'github', externalId: 'G1' }, kind: 'cancel' }
    ]) {
      expect(ConnectorDeliverySchema.safeParse(delivery).success).toBe(false)
    }
  })

  it('carries one control at a time', () => {
    expect(poll([], { control: { stop: 'client_too_old' } }).data?.control).toEqual({
      stop: 'client_too_old'
    })
    expect(poll([], { control: { pausedForMs: 0 } }).success).toBe(false)
    expect(poll([], { control: { stop: 'client_too_old', reconnect: true } }).success).toBe(false)
    expect(poll([], { control: { reconnect: true, addedLater: 1 } }).data?.control).toEqual({
      reconnect: true
    })
  })

  it('bounds the batch and the hold', () => {
    const tooMany = Array.from({ length: CONNECTOR_LIMITS.maxDeliveriesPerPoll + 1 }, () => start)
    expect(poll(tooMany).success).toBe(false)
    expect(poll([], { holdMs: CONNECTOR_LIMITS.pollTimeoutMs }).success).toBe(false)
  })
})

describe('acks', () => {
  it('accepts received and done with each result outcome', () => {
    const results = [
      { outcome: 'accepted', reopened: true },
      { outcome: 'refused', reason: 'prompt_not_pending' },
      { outcome: 'unknown', reason: 'no_local_record' },
      { outcome: 'expired' },
      { outcome: 'unsupported' }
    ]
    expect(
      ConnectorAcksRequestSchema.safeParse({
        v: 1,
        helloRev: 7,
        acks: [
          { deliveryId: 'd1', step: 'received' },
          ...results.map((result) => ({ deliveryId: 'd1', step: 'done', result }))
        ]
      }).success
    ).toBe(true)
    expect(
      ConnectorAcksRequestSchema.safeParse({
        v: 1,
        helloRev: 7,
        acks: [{ deliveryId: 'd1', step: 'done' }]
      }).success
    ).toBe(false)
  })

  it('names the hello they belong to', () => {
    const acks = [{ deliveryId: 'd1', step: 'received' }]
    expect(ConnectorAcksRequestSchema.safeParse({ v: 1, acks }).success).toBe(false)
  })
})

describe('events', () => {
  const turnEnded = {
    kind: 'turn-ended',
    conversation,
    paneKey: 'tab:leaf',
    turnId: 1_793_000_000_000,
    at: 1_793_000_060_000,
    stopReason: null
  }

  it('names the turn that ended by its start', () => {
    const { turnId: _, ...withoutTurnId } = turnEnded
    expect(ConnectorEventSchema.safeParse(turnEnded).success).toBe(true)
    expect(ConnectorEventSchema.safeParse(withoutTurnId).success).toBe(false)
  })

  it('caps the last assistant message in UTF-8 bytes', () => {
    const limit = CONNECTOR_LIMITS.maxLastAssistantMessageBytes
    expect(
      ConnectorEventSchema.safeParse({ ...turnEnded, lastAssistantMessage: 'a'.repeat(limit) })
        .success
    ).toBe(true)
    expect(
      ConnectorEventSchema.safeParse({ ...turnEnded, lastAssistantMessage: 'é'.repeat(limit / 2 + 1) })
        .success
    ).toBe(false)
  })

  it('carries the pending prompt in snapshots', () => {
    expect(
      ConnectorEventSchema.safeParse({
        kind: 'snapshot',
        conversations: [
          {
            conversation,
            paneKey: 'tab:leaf',
            agent: 'codex',
            working: false,
            prompt: { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
          }
        ]
      }).success
    ).toBe(true)
  })

  it('numbers every events batch within the hello it belongs to', () => {
    const events = [{ kind: 'turn-started', conversation, paneKey: 'tab:leaf', at: 1 }]
    const parse = (body: object) => ConnectorEventsRequestSchema.safeParse({ v: 1, events, ...body })
    expect(parse({ helloRev: 7, seq: 0 }).success).toBe(true)
    expect(parse({ helloRev: 7 }).success).toBe(false)
    expect(parse({ seq: 0 }).success).toBe(false)
    expect(parse({ helloRev: 7, seq: -1 }).success).toBe(false)
  })

  it('carries a question the agent left without text, as the seam reports it', () => {
    const prompt = {
      kind: 'question',
      promptId: 'p2',
      question: '',
      options: [{ id: '1', label: '' }]
    }
    expect(ConnectorPendingPromptSchema.safeParse(prompt).success).toBe(true)
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
    expect(hello(Array.from({ length: CONNECTOR_LIMITS.maxHelloProjects }, () => project(longest)))).toBe(true)
    expect(hello([project(`${longest}x`)])).toBe(false)
    expect(
      hello(Array.from({ length: CONNECTOR_LIMITS.maxHelloProjects + 1 }, () => project('orca')))
    ).toBe(false)
  })

  it('answers a hello with the revision the cloud assigned', () => {
    expect(ConnectorHelloResponseSchema.safeParse({ helloRev: 3 }).success).toBe(true)
    expect(ConnectorHelloResponseSchema.safeParse({}).success).toBe(false)
  })

  it('reads a reply as posted or queued', () => {
    expect(ConnectorReplyResponseSchema.parse({ status: 'queued' })).toEqual({ status: 'queued' })
    expect(
      ConnectorReplyResponseSchema.parse({ status: 'posted', messageId: '1793.0001' })
    ).toEqual({
      status: 'posted',
      messageId: '1793.0001'
    })
  })

  it('carries a conversation from any connected platform', () => {
    for (const source of ['slack', 'discord', 'linear']) {
      expect(
        ConnectorDeliverySchema.safeParse({
          ...base,
          conversation: { source, externalId: 'x1' },
          kind: 'cancel'
        }).success
      ).toBe(true)
    }
  })
})
