import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSlackConfig } from './slack-config.js'

describe('parseSlackConfig', () => {
  const key = randomBytes(32).toString('base64')

  it('is off without a token key', () => {
    expect(parseSlackConfig({})).toBeUndefined()
  })

  it('reads the kill switch and key', () => {
    expect(
      parseSlackConfig({ ORCA_CONNECTOR_SLACK_PAUSED: 'true', ORCA_CONNECTOR_SLACK_TOKEN_KEY: key })
    ).toEqual({ paused: true, tokenKey: Buffer.from(key, 'base64') })
  })

  it('reads the legacy route’s secret and allowlist', () => {
    expect(
      parseSlackConfig({
        ORCA_CONNECTOR_SLACK_SIGNING_SECRET: 'secret',
        ORCA_CONNECTOR_SLACK_TEAM_IDS: 'T1, T2',
        ORCA_CONNECTOR_SLACK_TOKEN_KEY: key
      })
    ).toEqual({
      legacy: { signingSecret: 'secret', teamIds: new Set(['T1', 'T2']) },
      paused: false,
      tokenKey: Buffer.from(key, 'base64')
    })
  })

  it.each([
    ['a legacy secret without its allowlist', { ORCA_CONNECTOR_SLACK_SIGNING_SECRET: 's', ORCA_CONNECTOR_SLACK_TOKEN_KEY: key }],
    ['a legacy secret without a key', { ORCA_CONNECTOR_SLACK_SIGNING_SECRET: 's', ORCA_CONNECTOR_SLACK_TEAM_IDS: 'T1' }],
    ['a short key', { ORCA_CONNECTOR_SLACK_TOKEN_KEY: 'AAAA' }]
  ])('refuses %s', (_name, env) => {
    expect(() => parseSlackConfig(env)).toThrow()
  })
})
