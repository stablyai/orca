import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { dispatchDelivery } from './connector-deliveries'
import { turnAutomations } from './connector-turn-automations'

type Listed = Pick<Automation, 'id' | 'name' | 'prompt' | 'bot' | 'on'>

const automation = (overrides: Partial<Listed>): Listed => ({
  id: 'auto-1',
  name: 'Triage',
  prompt: 'File an issue for each outage.',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  on: [{ id: 't1', source: 'slack', event: 'message' }],
  ...overrides
})

// A fixed deadline, well ahead of what msLeft reports.
const EXPIRES_AT = 2_000_000_000_000

const entry = (automationId = 'auto-1', botId = 'bot-1') => ({
  automationId,
  triggerId: 't1',
  botId,
  event: { key: 'T1:C1:1.1', occurredAt: 1, actorId: 'U0DANA' }
})
const BOTS = [{ id: 'bot-1' }]

describe('automations a bot turn runs', () => {
  it("notes each automation's instructions once, and records each event's run in the turn's chat", async () => {
    const run = vi.fn(async () => null)
    const taken = turnAutomations([automation({})], BOTS, [entry(), entry()], {
      takes: () => true,
      run
    })
    expect(taken?.note).toBe(
      [
        'This message also matches your automation "Triage":\nFile an issue for each outage.',
        'Do what each one asks as part of this turn, and answer once, covering the message and them.'
      ].join('\n\n')
    )
    const chat = { worktreeId: 'bot-home', sessionId: 'chat-1' }
    await taken?.record(chat)
    expect(run).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({ triggerId: 't1', key: 'T1:C1:1.1' }),
      { inTurn: chat }
    )
  })

  it('takes none its own run would refuse, gone, or another bot’s', () => {
    const deps = { takes: () => true, run: vi.fn(async () => null) }
    // Paused, made after the event, or already run: what a run of its own checks first.
    expect(
      turnAutomations([automation({})], BOTS, [entry()], { ...deps, takes: () => false })
    ).toBeNull()
    expect(turnAutomations([automation({})], BOTS, [entry('gone')], deps)).toBeNull()
    expect(turnAutomations([automation({})], BOTS, [entry('auto-1', 'bot-2')], deps)).toBeNull()
  })

  it('sends the note with the message, and records the runs once the turn takes it', async () => {
    const record = vi.fn(async () => {})
    const send = vi.fn(async () => ({ outcome: 'accepted' as const }))
    const chat = { worktreeId: 'bot-home', sessionId: 'chat-1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch calls only send and linkedChat here.
    const seam = { send, linkedChat: () => chat } as unknown as ExternalConversationSeam
    const dispatched = dispatchDelivery(
      seam,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads the host.
      {} as ExternalConversationHost,
      {
        runTrigger: async () => false,
        turnAutomations: () => ({ note: 'Also: Triage', record })
      },
      {
        kind: 'send',
        deliveryId: 'd1',
        expiresAt: EXPIRES_AT,
        conversation: { source: 'slack', externalId: 'T1:C1:1.1:U0BOT' },
        text: 'the deploy is red',
        automations: [entry()]
      },
      () => 60_000
    )
    // The cloud reads inTurn as the turn having run them, so it starts no run of their own.
    expect(await dispatched?.done).toEqual({ outcome: 'accepted', inTurn: true })
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'd1', {
      text: 'the deploy is red',
      note: 'Also: Triage'
    })
    expect(record).toHaveBeenCalledWith(chat)
  })

  it('records nothing for a turn that refused the message, so the cloud starts them on their own', async () => {
    const record = vi.fn(async () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch calls only send here.
    const seam = {
      send: async () => ({ outcome: 'refused', reason: 'agent_not_reachable' })
    } as unknown as ExternalConversationSeam
    const dispatched = dispatchDelivery(
      seam,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads the host.
      {} as ExternalConversationHost,
      { runTrigger: async () => false, turnAutomations: () => ({ note: 'n', record }) },
      {
        kind: 'send',
        deliveryId: 'd1',
        expiresAt: EXPIRES_AT,
        conversation: { source: 'slack', externalId: 'c' },
        text: 'hi',
        automations: [entry()]
      },
      () => 60_000
    )
    expect(await dispatched?.done).toEqual({ outcome: 'refused', reason: 'agent_not_reachable' })
    expect(record).not.toHaveBeenCalled()
  })
})
