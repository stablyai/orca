import { describe, expect, it } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import {
  CONNECTOR_CLOUD_FEATURES,
  CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE
} from '../../shared/connector-cloud-features'
import { applyBotUpdates } from '../../shared/rpc-contract/bots-params'
import { makeTestBot } from '../bots/bot.test-fixture'
import { connectorBots } from './connector-places'

function helloBots(bots: Bot[]) {
  return connectorBots({ getBots: () => bots })
}

describe('a bot’s Slack channel intro in the hello', () => {
  it('sends channelHello only as false, so an absent or on setting posts the intro as before', () => {
    const [off, on, unset] = helloBots([
      makeTestBot({ id: 'off', slackChannelHello: false }),
      makeTestBot({ id: 'on', slackChannelHello: true }),
      makeTestBot({ id: 'unset' })
    ])
    expect(off).toMatchObject({ id: 'off', channelHello: false })
    expect(on).not.toHaveProperty('channelHello')
    expect(unset).not.toHaveProperty('channelHello')
  })

  it('names the feature as the cloud does, kept out of the listed set', () => {
    // The cloud contract's own test (hello-channel-hello.test.ts) holds its side of this.
    expect(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE).toBe('slack.channelHello')
    expect(CONNECTOR_CLOUD_FEATURES).not.toContain(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
  })
})

describe('the saved Slack channel intro setting', () => {
  it('survives a save and reload, and an unrelated older client’s change keeps it', () => {
    const saved = BotSchema.parse(
      JSON.parse(JSON.stringify(applyBotUpdates(makeTestBot(), { slackChannelHello: false })))
    )
    expect(saved.slackChannelHello).toBe(false)
    expect(applyBotUpdates(saved, { paused: true }).slackChannelHello).toBe(false)
    expect(applyBotUpdates(saved, { slackChannelHello: true }).slackChannelHello).toBe(true)
  })

  it('reads a malformed value as unset (on) without losing the bot', () => {
    const parsed = BotSchema.parse({ ...makeTestBot(), slackChannelHello: 'nope' })
    expect(parsed.id).toBe('bot-1')
    expect(parsed.slackChannelHello).toBeUndefined()
  })
})
