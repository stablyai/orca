import { describe, expect, it } from 'vitest'
import { BotLaunchTools } from '../../../bots/bot-launch-tools'
import { claudeBotSessionOptions } from './claude-bot-session-options'

const basis = { instructions: async () => 'You are Scout.' }

async function toolsWithOneServer(): Promise<BotLaunchTools> {
  return BotLaunchTools.for(
    { grant: async () => ({ origin: 'http://127.0.0.1:1', token: 'token' }) },
    { botId: 'b1', folder: '/bots/scout', agent: 'claude' },
    [{ name: 'linear', command: 'linear-mcp', args: [] }]
  )
}

describe('claudeBotSessionOptions', () => {
  it('starts without the agent’s tools, and tells it why, when managed settings refuse them', async () => {
    const tools = await toolsWithOneServer()

    const allowed = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: false })
    expect(Object.keys(allowed.mcpServers ?? {})).toEqual(['linear'])
    expect(allowed.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are Scout.'
    })

    const refused = await claudeBotSessionOptions(basis, [], tools, { mcpConfig: true })
    expect(refused.mcpServers).toBeUndefined()
    expect(refused.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append:
        "You are Scout.\n\nYour own tools (MCP servers) are off in this session: your organization's Claude Code managed settings refuse them. Don't say you have them or try to use them."
    })
  })
})
