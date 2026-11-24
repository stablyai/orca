import { expect, it } from 'vitest'
import { makeTestBot } from '../bots/bot.test-fixture'
import { normalizePersistedBots } from '../../shared/bot-types'
import { applyBotUpdates, BotUpdate } from '../../shared/rpc-contract/bots-params'
import { connectorBots } from './connector-places'

it('preserves the thread reply preference through edits and storage without losing older bots', () => {
  const original = makeTestBot()
  const edit = BotUpdate.parse({ botId: original.id, updates: { slackThreadReplies: 'mentions' } })
  const saved = applyBotUpdates(original, edit.updates)
  expect(normalizePersistedBots(JSON.parse(JSON.stringify([saved])))[0]?.slackThreadReplies).toBe(
    'mentions'
  )
  expect(normalizePersistedBots([original])[0]?.slackThreadReplies).toBeUndefined()
  const [salvaged] = normalizePersistedBots([{ ...original, slackThreadReplies: 'future-mode' }])
  expect(salvaged?.id).toBe('bot-1')
  expect(salvaged?.slackThreadReplies).toBeUndefined()
  expect(
    BotUpdate.safeParse({ botId: original.id, updates: { slackThreadReplies: 'future-mode' } })
      .success
  ).toBe(false)
})

it('negotiates the preference before sending it and explicitly resets the cloud to always', () => {
  const bot = makeTestBot({ slackThreadReplies: 'mentions' })
  const store = { getBots: () => [bot] }
  expect(connectorBots(store)[0]).not.toHaveProperty('slackThreadReplies')
  expect(connectorBots(store, true, [], new Set())[0]).not.toHaveProperty('slackThreadReplies')
  const features = new Set(['slack.threadReplies'])
  const advertised = connectorBots(store, true, [], features)[0]
  expect(advertised?.slackThreadReplies).toBe('mentions')
  delete bot.slackThreadReplies
  expect(connectorBots(store, true, [], features)[0]?.slackThreadReplies).toBe('always')
})
