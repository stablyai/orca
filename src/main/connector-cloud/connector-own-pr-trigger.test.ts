import { describe, expect, it, vi } from 'vitest'
import { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { Automation } from '../../shared/automations/automation-definition'
import { runTriggerDelivery } from './connector-triggers'

const AUTOMATION: Pick<Automation, 'id' | 'bot' | 'on'> = {
  id: 'auto-1',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  on: [{ id: 'rule-1', source: 'github', event: 'pr_opened', in: ['acme/web'], fromOwner: true }]
}

// The owner's pull request from the branch a running worker's workspace has checked out.
const delivery = ConnectorDelivery.parse({
  kind: 'trigger',
  deliveryId: 'del-1',
  expiresAt: 2_000_000,
  conversation: { source: 'github', externalId: 'acme/web#5' },
  automationId: AUTOMATION.id,
  triggerId: 'rule-1',
  botId: 'bot-1',
  event: {
    key: 'pr:1:opened',
    occurredAt: 1_000_000,
    actorId: '100',
    fromOwner: true,
    place: 'acme/web',
    pr: { repoId: '777', number: 5, headRef: 'worker/fix-login', headSha: 'a'.repeat(40) }
  }
})

describe("a from=me pull request rule on the owner's own pull request", () => {
  it('starts for a pull request opened from a worker branch, with nothing checked first', async () => {
    if (delivery.kind !== 'trigger') {
      throw new Error('not a trigger delivery')
    }
    const run = vi.fn(async () => ({ id: 'run-1' }))
    const started = await runTriggerDelivery(
      { automations: [AUTOMATION], bots: [{ id: 'bot-1' }], webhook: () => false, run },
      delivery
    )
    expect(started).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({ source: 'github', event: 'pr_opened', fromOwner: true })
    )
  })
})
