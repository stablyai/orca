import { expect, it } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { normalizePersistedBots } from '../../../../shared/bot-types'
import {
  applyBotUpdates,
  BotUpdate,
  type BotHostUpdates
} from '../../../../shared/rpc-contract/bots-params'
import type { RpcContext } from '../core'
import type { RpcCallerIdentity } from '../callers/rpc-caller-identity'
import { BOT_METHODS } from './bots'

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

it('lets only the owner turn it on, and only where the cloud marks a reply that mentions the bot', async () => {
  const method = BOT_METHODS.find((entry) => entry.name === 'bots.update')!
  let saved = makeTestBot()
  const features = new Set<string>()
  const context = (caller: RpcCallerIdentity): RpcContext => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only reads the supplied caller, cloud features and bot store.
    return {
      caller,
      runtime: {
        getConnectorCloud: () => ({ cloudFeatures: () => features }),
        bots: {
          update: async (_id: string, updates: BotHostUpdates) => {
            saved = applyBotUpdates(saved, updates)
            return saved
          }
        }
      }
    } as unknown as RpcContext
  }
  const update = (mode: 'mentions' | 'always', caller: RpcCallerIdentity) =>
    method.handler({ botId: 'bot-1', updates: { slackThreadReplies: mode } }, context(caller))

  await expect(update('mentions', { kind: 'desktop' })).rejects.toThrow('does not support')
  expect(saved.slackThreadReplies).toBeUndefined()
  features.add('sends.mentioned')
  for (const caller of [
    { kind: 'local-cli' },
    { kind: 'paired-device', deviceId: 'phone', agent: true }
  ] as const) {
    await expect(update('mentions', caller)).rejects.toThrow('Only the owner')
    expect(saved.slackThreadReplies).toBeUndefined()
  }
  await update('mentions', { kind: 'paired-device', deviceId: 'phone' })
  expect(saved.slackThreadReplies).toBe('mentions')
  features.clear()
  await update('always', { kind: 'desktop' })
  expect(saved.slackThreadReplies).toBe('always')
})
