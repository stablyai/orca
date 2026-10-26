import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSlackConfig } from './slack-config.js'

describe('parseSlackConfig', () => {
  const key = randomBytes(32).toString('base64')

  it('is off without a signing secret', () => {
    expect(parseSlackConfig({})).toBeUndefined()
  })

  it('reads the allowlist, kill switch and key', () => {
    expect(
      parseSlackConfig({
        ORCA_CONNECTOR_SLACK_SIGNING_SECRET: 'secret',
        ORCA_CONNECTOR_SLACK_TEAM_IDS: 'T1, T2',
        ORCA_CONNECTOR_SLACK_PAUSED: 'true',
        ORCA_CONNECTOR_SLACK_TOKEN_KEY: key
      })
    ).toEqual({
      signingSecret: 'secret',
      teamIds: new Set(['T1', 'T2']),
      paused: true,
      tokenKey: Buffer.from(key, 'base64')
    })
  })

  it.each([
    ['no allowlist', { ORCA_CONNECTOR_SLACK_TOKEN_KEY: key }],
    ['no key', { ORCA_CONNECTOR_SLACK_TEAM_IDS: 'T1' }],
    ['a short key', { ORCA_CONNECTOR_SLACK_TEAM_IDS: 'T1', ORCA_CONNECTOR_SLACK_TOKEN_KEY: 'AAAA' }]
  ])('refuses %s', (_name, env) => {
    expect(() =>
      parseSlackConfig({ ORCA_CONNECTOR_SLACK_SIGNING_SECRET: 'secret', ...env })
    ).toThrow()
  })
})
