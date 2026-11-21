import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationWebhookTrigger } from '../../shared/automation-event-triggers'
import { webhookActorId, webhookRuleId } from '../../shared/connector-webhook-contract'
import { connectorTriggers, triggerRunEvent } from './connector-triggers'

type Listed = Pick<Automation, 'id' | 'enabled' | 'bot' | 'on' | 'missedRunGraceMinutes'>

const automation = (overrides: Partial<Listed>): Listed => ({
  id: 'auto-1',
  enabled: true,
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  on: [{ id: 't1', source: 'slack', event: 'mentioned', in: ['C0INFRA'] }],
  missedRunGraceMinutes: 720,
  ...overrides
})

describe('connector triggers', () => {
  it('never sends a Google rule to the cloud, nor takes a delivery for one', () => {
    const google = automation({
      on: [
        { id: 'mail', source: 'gmail', event: 'new_email' },
        { id: 't1', source: 'slack', event: 'mentioned' }
      ]
    })
    expect(connectorTriggers([google]).map((rule) => rule.id)).toEqual(['t1'])
    expect(
      triggerRunEvent([google], [{ id: 'bot-1' }], {
        automationId: 'auto-1',
        triggerId: 'mail',
        botId: 'bot-1',
        event: { key: 'k', occurredAt: 1, actorId: 'U1' }
      })
    ).toBeNull()
  })

  it("lists enabled bot automations' rules with their bot and grace", () => {
    expect(
      connectorTriggers([
        automation({}),
        automation({ id: 'paused', enabled: false }),
        automation({ id: 'project', bot: undefined })
      ])
    ).toEqual([
      {
        id: 't1',
        source: 'slack',
        event: 'mentioned',
        in: ['C0INFRA'],
        automationId: 'auto-1',
        botId: 'bot-1',
        graceMinutes: 720
      }
    ])
  })

  it('sends no display names to the cloud, which matches by refs and ids', () => {
    const [rule] = connectorTriggers([
      automation({
        on: [
          {
            id: 't1',
            source: 'slack',
            event: 'message',
            in: ['slack:T1:C1'],
            from: ['U1'],
            names: { 'slack:T1:C1': '#orca', U1: 'Nora' }
          }
        ]
      })
    ])
    expect(rule).toMatchObject({ in: ['slack:T1:C1'], from: ['U1'] })
    expect(rule).not.toHaveProperty('names')
  })

  it('marks the rules of an automation that answers in the thread', () => {
    const [rule] = connectorTriggers([
      automation({ bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'thread' } })
    ])
    expect(rule).toMatchObject({ id: 't1', inThread: true })
    expect(connectorTriggers([automation({})])[0]).not.toHaveProperty('inThread')
  })

  it("carries a thread-bound event's conversation into the run, and no other", () => {
    const delivery = {
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      conversation: { source: 'slack' as const, externalId: 'trigger:abc' },
      event: { key: 'T1:C0INFRA:1.1', occurredAt: 1, actorId: 'U0MEMBER', fromOwner: true as const }
    }
    const bots = [{ id: 'bot-1', members: [] }]
    expect(triggerRunEvent([automation({})], bots, { ...delivery, inThread: true })).toMatchObject({
      conversation: { source: 'slack', externalId: 'trigger:abc' }
    })
    // No thread on the event, or a cloud from before the mark: the result stays in the run.
    expect(triggerRunEvent([automation({})], bots, delivery)).not.toHaveProperty('conversation')
  })

  it("takes a delivery's source and kind from this Orca's own rule, for the bot it was listed for", () => {
    const event = { key: 'T1:C0INFRA:1.1', occurredAt: 1, text: 'hi' }
    const delivery = {
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: { ...event, actorId: 'U0MEMBER' }
    }
    const bots = [
      { id: 'bot-1', members: [{ id: 'U0MEMBER', name: 'Dana', source: 'slack' }] },
      { id: 'bot-2', members: [] }
    ]
    const automations = [automation({})]
    // Who did it stays on the run, so a bot request the run sends is held to them.
    expect(triggerRunEvent(automations, bots, delivery)).toEqual({
      ...event,
      triggerId: 't1',
      source: 'slack',
      event: 'mentioned',
      actorId: 'U0MEMBER'
    })
    expect(
      triggerRunEvent(automations, bots, {
        ...delivery,
        event: { ...delivery.event, fromOwner: true }
      })
    ).toMatchObject({ actorId: 'U0MEMBER', fromOwner: true })
    expect(triggerRunEvent(automations, bots, { ...delivery, triggerId: 'gone' })).toBeNull()
    // Listed for another bot: its Who can ask was never checked for this one.
    expect(triggerRunEvent(automations, bots, { ...delivery, botId: 'bot-2' })).toBeNull()
  })

  it("takes anyone's event, not only who can ask the bot, narrowed by the rule's own from and on=mine", () => {
    const delivery = {
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: { key: 'k', occurredAt: 1, actorId: 'U0STRANGER' }
    }
    const bots = [{ id: 'bot-1' }]
    expect(triggerRunEvent([automation({})], bots, delivery)).toMatchObject({
      key: 'k',
      source: 'slack'
    })
    const fromDana = automation({
      on: [{ id: 't1', source: 'slack', event: 'mentioned', from: ['U0DANA'] }]
    })
    expect(triggerRunEvent([fromDana], bots, delivery)).toBeNull()
    expect(
      triggerRunEvent([fromDana], bots, {
        ...delivery,
        event: { ...delivery.event, actorId: 'U0DANA' }
      })
    ).toMatchObject({ key: 'k' })
    // An older cloud never marks the owner's message, so on=mine starts nothing there.
    const mine = automation({
      on: [{ id: 't1', source: 'slack', event: 'reaction', onOwnerMessage: true }]
    })
    expect(triggerRunEvent([mine], bots, delivery)).toBeNull()
    expect(
      triggerRunEvent([mine], bots, {
        ...delivery,
        event: { ...delivery.event, onOwnerMessage: true }
      })
    ).toMatchObject({ key: 'k' })
  })

  it("takes the owner's own pull request only for a from=me rule, beside the people from names", () => {
    const head = { repoId: '777', number: 5, headRef: 'feature', headSha: 'a'.repeat(40) }
    const delivery = {
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: {
        key: 'pr:1:opened',
        occurredAt: 1,
        actorId: '100',
        fromOwner: true as const,
        pr: head
      }
    }
    const bots = [{ id: 'bot-1' }]
    const mine = automation({
      on: [{ id: 't1', source: 'github', event: 'pr_opened', fromOwner: true }]
    })
    const run = triggerRunEvent([mine], bots, delivery)
    expect(run).toMatchObject({ source: 'github', event: 'pr_opened', fromOwner: true })
    // The head only tells a bot worker's pull request apart; the run never quotes it.
    expect(run).not.toHaveProperty('pr')
    // from=me alone takes no one else's.
    const stranger = { ...delivery, event: { key: 'pr:2:opened', occurredAt: 1, actorId: '200' } }
    expect(triggerRunEvent([mine], bots, stranger)).toBeNull()
    // from=me,@dana: the owner's and Dana's, no one else's.
    const withDana = automation({
      on: [{ id: 't1', source: 'github', event: 'pr_opened', from: ['300'], fromOwner: true }]
    })
    expect(triggerRunEvent([withDana], bots, delivery)).toMatchObject({ fromOwner: true })
    expect(
      triggerRunEvent([withDana], bots, {
        ...stranger,
        event: { ...stranger.event, actorId: '300' }
      })
    ).toMatchObject({ actorId: '300' })
    expect(triggerRunEvent([withDana], bots, stranger)).toBeNull()
    // A rule naming people but not me still never takes the owner's.
    const danaOnly = automation({
      on: [{ id: 't1', source: 'github', event: 'pr_opened', from: ['300'] }]
    })
    expect(triggerRunEvent([danaOnly], bots, delivery)).toBeNull()
  })

  it("refuses the owner's pull request once from=me came off its rule, keeping everyone else's", () => {
    const head = { repoId: '777', number: 5, headRef: 'feature', headSha: 'a'.repeat(40) }
    const queued = {
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: {
        key: 'pr:1:opened',
        occurredAt: 1,
        actorId: '100',
        fromOwner: true as const,
        pr: head
      }
    }
    const bots = [{ id: 'bot-1' }]
    // The same rule, by id, without from=me: anyone's pull request, but not the owner's.
    const anyone = automation({ on: [{ id: 't1', source: 'github', event: 'pr_opened' }] })
    expect(triggerRunEvent([anyone], bots, queued)).toBeNull()
    const stranger = { ...queued, event: { key: 'pr:2:opened', occurredAt: 1, actorId: '200' } }
    expect(triggerRunEvent([anyone], bots, stranger)).toMatchObject({ actorId: '200' })
    // The owner's failing check still starts a ci_failed rule, as it always has.
    const ciFailed = automation({ on: [{ id: 't1', source: 'github', event: 'ci_failed' }] })
    expect(
      triggerRunEvent([ciFailed], bots, { ...queued, event: { ...queued.event, key: 'ci:1' } })
    ).toMatchObject({ event: 'ci_failed', fromOwner: true })
  })

  describe('a webhook call', () => {
    const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
    const OTHER = 'wh_0000000000000000'
    const CALL = 'call_0123456789abcdefABCD'
    const rule: AutomationWebhookTrigger = {
      id: webhookRuleId(HOOK),
      source: 'webhook',
      event: 'call',
      rev: 1,
      where: [{ path: 'body.action', op: '=', values: ['opened'] }]
    }
    const hooked = automation({ on: [rule] })
    const bots = [{ id: 'bot-1', members: [{ id: 'U0MEMBER', name: 'Dana', source: 'slack' }] }]
    const delivery = {
      automationId: 'auto-1',
      triggerId: webhookRuleId(HOOK),
      botId: 'bot-1',
      event: {
        key: CALL,
        actorId: webhookActorId(HOOK),
        occurredAt: 1,
        subject: '4512',
        webhook: { callId: CALL, epoch: 2, hostGen: 1 }
      }
    }

    it("is listed as the hook's rule, filters and all, until the cloud confirms its pause", () => {
      const listed = [{ ...rule, automationId: 'auto-1', botId: 'bot-1', graceMinutes: 720 }]
      expect(connectorTriggers([hooked])).toEqual(listed)
      // Paused, the rule stays only while the hook's own pause is unconfirmed; its Slack rule goes.
      const paused = automation({
        enabled: false,
        on: [{ id: 't1', source: 'slack', event: 'mentioned' }, rule]
      })
      expect(connectorTriggers([paused], (hookId) => hookId === HOOK)).toEqual(listed)
      expect(connectorTriggers([paused], () => false)).toEqual([])
    })

    it('starts only its own hook, as no person, without a member list', () => {
      expect(triggerRunEvent([hooked], bots, delivery)).toEqual({
        key: CALL,
        occurredAt: 1,
        subject: '4512',
        triggerId: webhookRuleId(HOOK),
        source: 'webhook',
        event: 'call'
      })
      // Another hook's key: refused. The contract already rejects a call that claims the owner.
      expect(
        triggerRunEvent([hooked], bots, {
          ...delivery,
          event: { ...delivery.event, actorId: webhookActorId(OTHER) }
        })
      ).toBeNull()
      // Naming another hook's rule finds no rule here.
      expect(
        triggerRunEvent([hooked], bots, { ...delivery, triggerId: webhookRuleId(OTHER) })
      ).toBeNull()
    })

    it("never lets a hook's actor through a Slack rule, and leaves member checks as they were", () => {
      const both = automation({ on: [{ id: 't1', source: 'slack', event: 'mentioned' }, rule] })
      expect(triggerRunEvent([both], bots, { ...delivery, triggerId: 't1' })).toBeNull()
      expect(
        triggerRunEvent([both], bots, {
          ...delivery,
          triggerId: 't1',
          event: { key: 'k', occurredAt: 1, actorId: 'U0MEMBER' }
        })
      ).toMatchObject({ source: 'slack' })
    })
  })
})
