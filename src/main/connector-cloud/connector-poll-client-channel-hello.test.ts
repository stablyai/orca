import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE } from '../../shared/connector-cloud-features'
import { makeTestBot } from '../bots/bot.test-fixture'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { connectorBots } from './connector-places'

const h = pollClientHarness()

type SaidHello = { bots?: { id: string; channelHello?: boolean }[] }

describe('ConnectorPollClient and the Slack channel intro switch', () => {
  it('says a bot whose intro was turned off in the next hello, and the field only then', async () => {
    let bots: Bot[] = [makeTestBot({ id: 'scout' })]
    const { client } = h.startClient(undefined, undefined, (fake) => {
      fake.bots = () => connectorBots({ getBots: () => bots })
    })
    await settle()
    expect((h.fake.hellos.at(-1) as SaidHello).bots?.[0]).not.toHaveProperty('channelHello')

    bots = [makeTestBot({ id: 'scout', slackChannelHello: false })]
    // As the connector does on every bot write (onHelloInputsChanged).
    client.sayChanged()
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect((h.fake.hellos.at(-1) as SaidHello).bots?.[0]).toMatchObject({
      id: 'scout',
      channelHello: false
    })
    client.stop()
  })

  it('reports a change in what the cloud takes, and not an answer that lists the same', async () => {
    const onFeaturesChanged = vi.fn()
    h.fake.features = ['webhooks']
    const { client } = h.startClient(undefined, undefined, undefined, { onFeaturesChanged })
    await settle()
    // None yet to some: bots.list can now say what the cloud takes.
    expect(onFeaturesChanged).toHaveBeenCalledTimes(1)

    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(30_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(onFeaturesChanged).toHaveBeenCalledTimes(1)

    h.fake.features = ['webhooks', CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE]
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(30_000)
    expect(h.fake.hellos).toHaveLength(3)
    expect(onFeaturesChanged).toHaveBeenCalledTimes(2)
    client.stop()
  })
})
