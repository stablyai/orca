import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_CLOUD_FEATURES,
  CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE,
  ConnectorBotPageRequestSchema,
  ConnectorHelloRequestSchema
} from './hello-messages.js'

const hello = {
  v: 1,
  contract: 1,
  orcaVersion: '1.4.230',
  platform: 'darwin',
  runtime: 'desktop',
  hostName: 'mac',
  promptKinds: [],
  features: ['trigger'],
  sources: ['slack']
}
const bot = { id: 'bot-1', name: 'Reviewer', agent: 'claude', members: [], paused: false }

describe('a bot’s Slack channel intro switch', () => {
  it('reads false as off and absent as on', () => {
    const parsed = ConnectorHelloRequestSchema.parse({
      ...hello,
      bots: [{ ...bot, id: 'off', channelHello: false }, bot]
    })
    expect(parsed.bots?.map((entry) => entry.channelHello)).toEqual([false, undefined])
  })

  it('drops a value it can’t read instead of refusing the hello or the staged page', () => {
    for (const channelHello of ['off', 0, null, {}]) {
      const inline = ConnectorHelloRequestSchema.safeParse({ ...hello, bots: [{ ...bot, channelHello }] })
      expect(inline.success).toBe(true)
      expect(inline.data?.bots?.[0]?.channelHello).toBeUndefined()
      const page = ConnectorBotPageRequestSchema.safeParse({
        v: 1,
        inventoryId: 'inv-1',
        index: 0,
        pages: 1,
        bots: [{ ...bot, channelHello }]
      })
      expect(page.success).toBe(true)
    }
  })

  it('keeps its feature out of the listed set: only the code that honours the field lists it', () => {
    // The desktop's copy (src/shared/connector-cloud-features.ts) names the same string.
    expect(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE).toBe('slack.channelHello')
    expect(CONNECTOR_CLOUD_FEATURES).not.toContain(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
  })
})
