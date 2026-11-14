import { expect, it } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
  fixture,
  CALLER,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  ask,
  cancelCard,
  cardResolution,
  openTurn,
  statusTexts
} from './structured-agent-session-claude-stop-contract-test-actions'

it('dismisses a plan card on its Cancel: Claude is told to wait for the user, and keeps running', async () => {
  const connection = fixture.claude.connections[0]!
  const turnId = await openTurn(connection)
  const { answered, card } = await ask(connection, 'ExitPlanMode', {
    plan: '# Release\n\n- Tag it'
  })

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  await laneDrained()

  const reply = await answered.promise
  expect(reply).toMatchObject({ behavior: 'deny' })
  expect(reply).not.toHaveProperty('interrupt')
  expect(JSON.stringify(reply)).toMatch(/wait for them/)
  expect(JSON.stringify(reply)).not.toMatch(/keep planning|ExitPlanMode again/i)
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  const cards = (await fixture.host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'approval'
  )
  expect(cards).toHaveLength(1)
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(await statusTexts()).toEqual([])
})
