import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseDiscordConfig } from './discord-config.js'

describe('parseDiscordConfig', () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const hex = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString('hex')
  const env = {
    ORCA_CONNECTOR_DISCORD_PUBLIC_KEY: hex,
    ORCA_CONNECTOR_DISCORD_BOT_TOKEN: 'bot-token',
    ORCA_CONNECTOR_DISCORD_GUILD_IDS: 'G1, G2'
  }

  it('is off without a public key', () => {
    expect(parseDiscordConfig({})).toBeUndefined()
  })

  it('reads the key, token, allowlist and kill switch', () => {
    const config = parseDiscordConfig({ ...env, ORCA_CONNECTOR_DISCORD_PAUSED: 'true' })
    expect(config).toMatchObject({
      botToken: 'bot-token',
      guildIds: new Set(['G1', 'G2']),
      paused: true
    })
    expect(config?.publicKey.equals(publicKey)).toBe(true)
  })

  it.each([
    ['no allowlist', { ORCA_CONNECTOR_DISCORD_GUILD_IDS: undefined }],
    ['no bot token', { ORCA_CONNECTOR_DISCORD_BOT_TOKEN: undefined }],
    ['a short key', { ORCA_CONNECTOR_DISCORD_PUBLIC_KEY: 'abcd' }]
  ])('refuses %s', (_name, override) => {
    expect(() => parseDiscordConfig({ ...env, ...override })).toThrow()
  })
})
