import { describe, expect, it } from 'vitest'
import { BotLaunchTools, withBotLaunchToolsEnv } from './bot-launch-tools'

const relayedTools = () =>
  BotLaunchTools.for(
    { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 't' }) },
    { botId: 'b', folder: '/b', agent: 'claude' },
    [{ name: 'docs', url: 'https://docs.example/mcp', credential: 'cred-docs-1' }]
  )

describe("a bot launch's environment", () => {
  it('lets the CLI reach the relay directly behind a proxy, keeping the bypasses it had', async () => {
    const relayed = await relayedTools()
    const env = withBotLaunchToolsEnv(
      {
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: 'corp.example, localhost',
        no_proxy: '.internal'
      },
      relayed
    )
    expect(env.NO_PROXY).toBe('corp.example,localhost,.internal,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.ORCA_BOT_TOOLS_TOKEN).toBe('t')
  })

  it('leaves a launch with no relayed tool alone', () => {
    const base = { HTTPS_PROXY: 'http://proxy:3128' }
    expect(withBotLaunchToolsEnv(base, BotLaunchTools.none)).toBe(base)
  })
})

describe('launch tools', () => {
  it('come only from BotLaunchTools.for, never from a plain object with the same fields', () => {
    // @ts-expect-error A raw server list with its header can't stand in for launch tools.
    const raw: BotLaunchTools = {
      servers: [{ name: 'docs', url: 'https://x.test/mcp', headers: { a: 'secret' } }],
      env: {},
      relayed: false
    }
    expect(raw).toBeDefined()
  })
})
