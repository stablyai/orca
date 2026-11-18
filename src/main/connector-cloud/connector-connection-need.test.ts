import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../bots/bot.test-fixture'
import { hostNeedsConnector } from './connector-connection-need'

const homeOnly = makeTestBot()

describe('hostNeedsConnector', () => {
  it('is off for home-chat-only bots, and for no bots', () => {
    expect(hostNeedsConnector([], [])).toBe(false)
    expect(hostNeedsConnector([homeOnly], [])).toBe(false)
    // An event rule hears nothing without its bot's connector.
    expect(hostNeedsConnector([homeOnly], [{ source: 'slack' }])).toBe(false)
  })

  it('is on for a bot on Slack, Linear or GitHub, in either shape of each', () => {
    for (const connected of [
      { slack: { appId: 'A1', teamId: 'T1' } },
      { slackApps: [{ appId: 'A1', teamId: 'T1' }] },
      { linear: { workspaceId: 'L1', workspaceName: 'Acme' } },
      { linearWorkspaces: [{ workspaceId: 'L1', workspaceName: 'Acme' }] },
      { github: {} }
    ]) {
      expect(hostNeedsConnector([homeOnly, makeTestBot(connected)], [])).toBe(true)
    }
  })

  it('is on for a webhook rule', () => {
    expect(hostNeedsConnector([homeOnly], [{ source: 'webhook' }])).toBe(true)
  })
})
