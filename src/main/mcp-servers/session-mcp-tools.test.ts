import { describe, expect, it } from 'vitest'
import type { BotToolServer } from '../../shared/bot-tools'
import { SessionMcpTools } from './session-mcp-tools'

const relay = { grant: async () => ({ origin: 'http://127.0.0.1:1', token: 'token' }) }
const calendar: BotToolServer = {
  name: 'calendar',
  url: 'https://calendar.example/mcp',
  transport: 'http',
  credential: 'calendar-credential'
}

describe('a launch bound to this run of Orca', () => {
  it('holds only while a relay token reaches the agent', async () => {
    const host = { folder: '/tmp/host-list', servers: [calendar] }
    const offered = await SessionMcpTools.for(relay, { bot: null, agent: 'codex' }, { host })
    expect(offered.appBound).toBe(true)
    // The agent's own server of that name replaces the relayed one: no token reaches it.
    expect(offered.beside(['calendar']).tools.appBound).toBe(false)
    const bot = { botId: 'scout', folder: '/tmp/scout' }
    expect((await SessionMcpTools.for(relay, { bot, agent: 'codex' }, {})).appBound).toBe(true)
    expect(SessionMcpTools.none.appBound).toBe(false)
  })
})
