import { describe, expect, it, vi } from 'vitest'
import { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import { codexBotToolsThreadConfig } from '../../../bots/bot-tools-codex'
import { withCodexBotToolsFitted } from './codex-bot-tools-fit'

const relay = { grant: async () => ({ origin: 'http://127.0.0.1:1', token: 'token' }) }

function connection(ownServers: Record<string, unknown>) {
  return {
    request: vi.fn(async (method: string) => {
      if (method !== 'config/read') {
        throw new Error(`unexpected ${method}`)
      }
      return { config: { mcp_servers: ownServers }, origins: {} }
    })
  }
}

describe('a native chat Codex launch with a bot’s tools', () => {
  it('opens without a remote notion the owner’s config runs as a command', async () => {
    const tools = await SessionMcpTools.for(
      relay,
      { bot: { botId: 'bot-1', folder: '/bots/one' }, agent: 'codex' },
      { own: [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }] }
    )
    const launch = {
      cwd: '/work',
      model: 'gpt',
      threadConfig: { ...codexBotToolsThreadConfig(tools, new Set()), web_search: 'live' }
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const fitted = await withCodexBotToolsFitted(
      connection({ notion: { command: 'npx', args: ['-y', 'mcp-remote'] } }),
      launch,
      { sessionId: 's1', logger }
    )
    expect(fitted).toEqual({ cwd: '/work', model: 'gpt', threadConfig: { web_search: 'live' } })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      scope: 'botTools.codex',
      sessionId: 's1',
      names: ['notion']
    })
  })

  it('leaves a launch without servers, or without conflicts, as it is', async () => {
    const none = { cwd: '/work' }
    const quiet = connection({})
    expect(await withCodexBotToolsFitted(quiet, none, { sessionId: 's1' })).toBe(none)
    expect(quiet.request).not.toHaveBeenCalled()
    const same = { cwd: '/work', threadConfig: { 'mcp_servers.notion.url': 'https://n/mcp' } }
    expect(
      await withCodexBotToolsFitted(connection({ notion: { url: 'https://o/mcp' } }), same, {
        sessionId: 's1'
      })
    ).toBe(same)
  })
})
